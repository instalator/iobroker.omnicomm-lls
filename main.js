'use strict';
const utils = require('@iobroker/adapter-core');
const SerialPort = require('serialport');
const InterByteTimeout = require('@serialport/parser-inter-byte-timeout');
let adapter, serial, pollInterval, firststart = true, obj = {};
let parser;

function startAdapter(options){
    return adapter = utils.adapter(Object.assign({}, options, {
        name:        'omnicomm-lls',
        ready:       main,
        unload:      (callback) => {
            try {
                pollInterval && clearInterval(pollInterval);
                serial.pause();
                serial.close();
                adapter.log.info('cleaned everything up...');
                callback();
            } catch (e) {
                callback();
            }
        },
        stateChange: (id, state) => {
            if (id && state && !state.ack){
                adapter.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
                const arr = id.split('.');
                id = arr[arr.length - 1];
                let val = state.val;
                if (id === 'onPeriodData'){ //Периодическая выдача данных
                    send([0x31, obj.address, 0x07]);
                }
                if (id === 'mode'){ //Режим выдачи данных по умолчанию
                    if (val < 0) val = 0;
                    if (val > 2) val = 2;
                    send([0x31, obj.address, 0x17, parseInt(val, 10)]);
                }
                if (id === 'interval'){ //Изменение интервала периодической выдачи
                    if (val < 0) val = 0;
                    if (val > 255) val = 255;
                    send([0x31, obj.address, 0x13, parseInt(val, 10)]);
                }
                if (id === 'filter'){ //Установка глубины фильтрации
                    if (val < 0) val = 0;
                    if (val > 20) val = 20;
                    send([0x31, obj.address, 0x0E, parseInt(val, 10)]);
                }
            }
        },
        message:     (obj) => {
            if (typeof obj === 'object' && obj.message){
                if (obj.command === 'getSerialPorts'){
                    listSerial().then((ports) => {
                        adapter.log.debug('List of ports: ' + JSON.stringify(ports));
                        obj.callback && adapter.sendTo(obj.from, obj.command, ports, obj.callback);
                    });
                }
            }
        },
    }));
}

function send(cmd){
    const crc = getCRC(cmd);
    cmd = Buffer.from(cmd.concat(crc));
    serial.write(cmd);
}

function main(){
    adapter.subscribeStates('*');
    adapter.setState('info.connection', false, true);
    obj.address = parseInt(adapter.config.address, 10);
    if (adapter.config.usbport){
        serial = new SerialPort(adapter.config.usbport, {
            baudRate: parseInt(adapter.config.baud, 10) || 19200,
        });
        serial.on('open', () => {
            adapter.setState('info.connection', true, true);
            parser = serial.pipe(new InterByteTimeout({maxBufferSize: 512, interval: 500}));
            parser.on('data', (data) => {
                adapter.log.debug(JSON.stringify(data));
                parse(data);
            });
            serial.on('error', (err) => {
                adapter.log.error('Error: ' + err);
            });
            pollInterval && clearInterval(pollInterval);
            pollInterval = setInterval(() => {
                let cmd;
                if (firststart){
                    firststart = false;
                    cmd = [0x31, obj.address, 0x10];
                } else {
                    cmd = [0x31, obj.address, 0x06];
                }
                send(cmd);
            }, adapter.config.pollTime || 5000);
        });
    }
}

function parse(data){
    adapter.log.debug('Received = ' + data.toString('hex'));

    //data = Buffer.from([0x3E, 0x03, 0x06, 0x30, 0x10, 0x20, 0x20, 0x30, 0xe7]);
    //data = Buffer.from([0x3e, 0x03, 0x10, 0x4c, 0x4c, 0x53, 0x20, 0x33, 0x30, 0x31, 0x36, 0x30, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x4c, 0x4c, 0x53, 0x20, 0x33, 0x2e, 0x39, 0x2e, 0x31, 0x2e, 0x32, 0x00, 0x03, 0x0a, 0x00, 0x00, 0xff, 0x0f, 0xb3, 0xfd, 0x00, 0xb4, 0x2c, 0x01, 0x01]);

    const crc = getCRC(data.slice(0, data.length - 1));
    adapter.log.debug('Checksum = ' + crc.toString(16));
    if (crc === data[data.length - 1]){
        adapter.log.debug('Чек сумма совпала');
        if (data[2] === 0x06){
            let temp = (data[3] & 0x7F);
            if ((data[3] & 0x80) > 0) temp = temp * -1;

            const litr = ((data[5] << 8) | data[4]); //
            const in_min = ((0x00 << 8) | 0x00);  //Значения при тарировке минимум  // 0
            const in_max = ((0x0F << 8) | 0xFF);  //Значения при тарировке максимум // 4095
            const fuel = Scaler(litr, in_min, in_max, 0, 18).toFixed(2);  //Количество литров в баке

            adapter.log.debug('in_min = ' + in_min + ' in_max = ' + in_max + ' litr = ' + litr + ' temp = ' + temp);
            adapter.log.debug('Литраж = ' + Scaler(litr, in_min, in_max, 0, 25).toFixed(2));

            adapter.setState('level', fuel, true);
            adapter.setState('temperature', temp, true);
            adapter.setState('relative_level', litr, true);
            adapter.setState('frequency_value', ((data[7] << 8) | data[6]), true);
        } else if (data[2] === 0x10){
            obj.model = data.slice(3, 19).toString();
            obj.version = data.slice(19, 30).toString();
            obj.mode = data.readInt8(30);
            obj.interval = data.readInt8(31);
            obj.filter = data.readInt8(32);
            obj.min = data.readInt16LE(33);
            obj.max = data.readInt16LE(35);
            obj.CNT1 = Buffer.concat([data.slice(37, 40), Buffer.from([0x00])]).readInt32LE(0);
            obj.CNT2 = Buffer.concat([data.slice(40, 43), Buffer.from([0x00])]).readInt32LE(0);
            adapter.setState('model', obj.model, true);
            adapter.setState('version', obj.version, true);
            adapter.setState('mode', obj.mode, true);
            adapter.setState('interval', obj.interval, true);
            adapter.setState('filter', obj.filter, true);
            adapter.setState('min', obj.min, true);
            adapter.setState('max', obj.max, true);
            adapter.setState('CNT1', obj.CNT1, true);
            adapter.setState('CNT2', obj.CNT2, true);
        }
    }
}

function Scaler(input, in_min, in_max, out_min, out_max){
    let out1 = 0;
    let out2 = 0;
    const diff = in_max - in_min;
    if (diff !== 0){
        if (input > in_max){
            out1 = in_max;
        } else {
            out1 = input;
        }
        if (in_min > out1){
            out2 = in_min;
        } else {
            out2 = out1;
        }
        return (out_max - out_min) / diff * (out2 - in_min) + out_min;
    }
}

function listSerial(){
    return SerialPort.list()
        .then(ports =>
            ports.map(port => {
                return {path: port.path};
            })
        ).catch(err => {
            adapter.log.error(err);
            return {path: 'Not available'};
        });
}

function getCRC(byte_array){
    let c = 0;
    const table = [
        0x00, 0x5E, 0xBC, 0xE2, 0x61, 0x3F, 0xDD, 0x83, 0xC2, 0x9C, 0x7E, 0x20,
        0xA3, 0xFD, 0x1F, 0x41, 0x9D, 0xC3, 0x21, 0x7F, 0xFC, 0xA2, 0x40, 0x1E,
        0x5F, 0x01, 0xE3, 0xBD, 0x3E, 0x60, 0x82, 0xDC, 0x23, 0x7D, 0x9F, 0xC1,
        0x42, 0x1C, 0xFE, 0xA0, 0xE1, 0xBF, 0x5D, 0x03, 0x80, 0xDE, 0x3C, 0x62,
        0xBE, 0xE0, 0x02, 0x5C, 0xDF, 0x81, 0x63, 0x3D, 0x7C, 0x22, 0xC0, 0x9E,
        0x1D, 0x43, 0xA1, 0xFF, 0x46, 0x18, 0xFA, 0xA4, 0x27, 0x79, 0x9B, 0xC5,
        0x84, 0xDA, 0x38, 0x66, 0xE5, 0xBB, 0x59, 0x07, 0xDB, 0x85, 0x67, 0x39,
        0xBA, 0xE4, 0x06, 0x58, 0x19, 0x47, 0xA5, 0xFB, 0x78, 0x26, 0xC4, 0x9A,
        0x65, 0x3B, 0xD9, 0x87, 0x04, 0x5A, 0xB8, 0xE6, 0xA7, 0xF9, 0x1B, 0x45,
        0xC6, 0x98, 0x7A, 0x24, 0xF8, 0xA6, 0x44, 0x1A, 0x99, 0xC7, 0x25, 0x7B,
        0x3A, 0x64, 0x86, 0xD8, 0x5B, 0x05, 0xE7, 0xB9, 0x8C, 0xD2, 0x30, 0x6E,
        0xED, 0xB3, 0x51, 0x0F, 0x4E, 0x10, 0xF2, 0xAC, 0x2F, 0x71, 0x93, 0xCD,
        0x11, 0x4F, 0xAD, 0xF3, 0x70, 0x2E, 0xCC, 0x92, 0xD3, 0x8D, 0x6F, 0x31,
        0xB2, 0xEC, 0x0E, 0x50, 0xAF, 0xF1, 0x13, 0x4D, 0xCE, 0x90, 0x72, 0x2C,
        0x6D, 0x33, 0xD1, 0x8F, 0x0C, 0x52, 0xB0, 0xEE, 0x32, 0x6C, 0x8E, 0xD0,
        0x53, 0x0D, 0xEF, 0xB1, 0xF0, 0xAE, 0x4C, 0x12, 0x91, 0xCF, 0x2D, 0x73,
        0xCA, 0x94, 0x76, 0x28, 0xAB, 0xF5, 0x17, 0x49, 0x08, 0x56, 0xB4, 0xEA,
        0x69, 0x37, 0xD5, 0x8B, 0x57, 0x09, 0xEB, 0xB5, 0x36, 0x68, 0x8A, 0xD4,
        0x95, 0xCB, 0x29, 0x77, 0xF4, 0xAA, 0x48, 0x16, 0xE9, 0xB7, 0x55, 0x0B,
        0x88, 0xD6, 0x34, 0x6A, 0x2B, 0x75, 0x97, 0xC9, 0x4A, 0x14, 0xF6, 0xA8,
        0x74, 0x2A, 0xC8, 0x96, 0x15, 0x4B, 0xA9, 0xF7, 0xB6, 0xE8, 0x0A, 0x54,
        0xD7, 0x89, 0x6B, 0x35];
    for (let i = 0; i < byte_array.length; i++)
        c = table[(c ^ byte_array[i]) % 256];
    return c;
}

if (module.parent){
    module.exports = startAdapter;
} else {
    startAdapter();
}