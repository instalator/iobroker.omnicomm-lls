const namespace = 'omnicomm-lls.' + instance,
    namespaceLen = namespace.length;
let options = {};
let serialPorts = [];
let lang;

function load(settings, onChange){
    if (!settings) return;
    lang = systemLang || 'en';
    $('.value').each(function (){
        var $key = $(this);
        var id = $key.attr('id');
        if ($key.attr('type') === 'checkbox'){
            $key.prop('checked', settings[id])
                .on('change', () => onChange())
            ;
        } else {
            $key.val(settings[id])
                .on('change', () => onChange())
                .on('keyup', () => onChange())
            ;
        }
    });
    getSerialPorts();
    onChange(false);
    if (M) M.updateTextFields();
}

function save(callback){
    var obj = {};
    $('.value').each(function (){
        var $this = $(this);
        if ($this.attr('type') === 'checkbox'){
            obj[$this.attr('id')] = $this.prop('checked');
        } else {
            obj[$this.attr('id')] = $this.val();
        }
    });
    callback(obj);
}

$(document).ready(function (){
    sockets();
    $('.serial-list-btn').click(function (){
        $('#usbport').focus().click();
    });
});

function getSerialPorts(){
    console.log('getSerialPorts ' + namespace);
    sendTo(namespace, 'getSerialPorts', {}, function (msg){
        console.log('serialPorts =  ' + JSON.stringify(msg));
        if (msg){
            if (msg.error){
                showMessage(_(msg.error), _('Error'), 'error_outline');
            } else {
                serialPorts = msg;
                $('#serial-list').empty();
                $.each(serialPorts, function (i, item){
                    $('#serial-list').append($('<option>').text(item.path));
                });
                M.updateTextFields();
            }
        }
    });
}


function sockets(){
    socket.emit('subscribe', namespace + '.info.*');
    socket.emit('subscribeObjects', namespace + '.*');
    socket.on('stateChange', function (id, state){
        if (id.substring(0, namespaceLen) !== namespace) return;
        if (state){

        }
    });
    socket.on('objectChange', function (id, obj){
        if (id.substring(0, namespaceLen) !== namespace) return;
        if (obj && obj.type == 'device' && obj.common.type !== 'group'){

        }
    });
    socket.emit('getObject', 'system.config', function (err, res){
        if (!err && res && res.common){
            systemLang = res.common.language || systemLang;
            systemConfig = res;
        }
    });
}
