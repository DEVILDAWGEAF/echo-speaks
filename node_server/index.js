/* jshint -W097 */
/* jshint -W030 */
/* jshint strict: false */
/* jslint node: true */
/* jslint esversion: 6 */
"use strict";

const appVer = '0.4.0';
const alexa_api = require('./alexa-api');
const reqPromise = require("request-promise");
const logger = require('./logger');
const express = require('express');
const bodyParser = require('body-parser');
const os = require('os');
const alexaCookie = require('./alexa-cookie/alexa-cookie');
const editJsonFile = require("edit-json-file", {
    autosave: true
});
const dataFolder = os.homedir() + '/.echo-speaks'
const configFile = editJsonFile(dataFolder + '/es_config.json');
const fs = require('fs');
const webApp = express();
const urlencodedParser = bodyParser.urlencoded({
    extended: false
});

// These the config variables
var configData = {};
var scheduledUpdatesActive = false;
var savedConfig = {};
var command = {};
var serviceStartTime = Date.now(); //Returns time in millis
var eventCount = 0;
var echoDevices = {};

function initConfig() {
    logger.debug('dataFolder: ' + dataFolder);
    // Create the log directory if it does not exist
    if (!fs.existsSync(dataFolder)) {
        fs.mkdirSync(dataFolder);
    }
    if (!fs.existsSync(dataFolder + '/logs')) {
        fs.mkdirSync(dataFolder + '/logs');
    }
    loadConfig();
}

function loadConfig() {
    configData = configFile.get() || {};
    // console.log(configData);
    configData.serverPort = configData.serverPort || 8091;
    configData.proxyPort = configData.proxyPort || 8092;
    configData.refreshSeconds = configData.refreshSeconds || 60;

    configFile.save();
}
initConfig()

function startWebConfig() {
    return new Promise(function(resolve, reject) {
        try {
            webApp.listen(configData.serverPort, function() {
                logger.info('** Echo Speaks Config Service (v' + appVer + ') is Running at (IP: ' + getIPAddress() + ' | Port: ' + configData.serverPort + ') | ProcessId: ' + process.pid + ' **');
                if (!configCheckOk()) {
                    logger.warn('** Configurations Settings Missing... Please visit http://' + getIPAddress() + ':' + configData.serverPort + '/config to configure settings...');
                } else {
                    logger.info('** Configurations Page available at (http://' + getIPAddress() + ':' + configData.serverPort + '/config)');
                }

            });
            webApp.use(function(req, res, next) {
                res.header("Access-Control-Allow-Origin", "*");
                res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
                next();
            });
            webApp.get('/config', function(req, res) {
                res.sendFile(__dirname + '/public/index.html');
            });
            webApp.get('/configData', function(req, res) {
                res.send(JSON.stringify(configData));
            });
            webApp.post('/configData', function(req, res) {
                if (req.headers.user) {
                    configFile.set('user', req.headers.user);
                };
                if (req.headers.password) {
                    configFile.set('password', req.headers.password);
                };
                if (req.headers.smartthingshubip) {
                    configFile.set('smartThingsHubIP', req.headers.smartthingshubip);
                };
                if (req.headers.url) {
                    configFile.set('url', req.headers.url);
                };
                if (req.headers.refreshseconds) {
                    configFile.set('refreshSeconds', parseInt(req.headers.refreshseconds));
                };
                // console.log('configData(set): ', configData);
                if (req.headers.user.length && req.headers.password.length && req.headers.smartthingshubip.length && req.headers.url.length && req.headers.refreshseconds.length) {
                    configFile.save();
                    loadConfig();
                    res.send('done');
                    if (configCheckOk()) {
                        tsLogger("** Settings File Updated via Web Config **");
                        if (!scheduledUpdatesActive) {
                            startWebServer();
                        }
                    }
                } else {
                    res.send('failed');
                }
            });
            resolve(true)
        } catch (ex) {
            reject(ex)
        }
    });
}

function startWebServer() {
    const alexaOptions = { // options is optional at all
        // logger: logger.debug, // optional: Logger instance to get (debug) logs
        amazonPage: configData.url, // optional: possible to use with different countries, default is 'amazon.de'
        setupProxy: true, // optional: should the library setup a proxy to get cookie when automatic way did not worked? Default false!
        proxyOwnIp: getIPAddress(), // required if proxy enabled: provide own IP or hostname to later access the proxy. needed to setup all rewriting and proxy stuff internally
        proxyPort: configData.proxyPort, // optional: use this port for the proxy, default is 0 means random port is selected
        proxyListenBind: '0.0.0.0', // optional: set this to bind the proxy to a special IP, default is '0.0.0.0'
        proxyLogLevel: 'warn' // optional: Loglevel of Proxy, default 'warn'
    };

    alexa_api.alexaLogin(configData.user, configData.password, alexaOptions, function(error, response, config) {
        savedConfig = config;
        // console.log('error:', error);
        console.log('Alexa Login Status: ', response);
        // console.log('config: ', config);
        if (response.startsWith('Logged in') && config.devicesArray) {
            buildEchoDeviceMap(config.devicesArray.devices)
                .then(function(devOk) {
                    tsLogger('Echo Speaks Alexa API is Actively Running at (IP: ' + getIPAddress() + ' | Port: ' + configData.serverPort + ') | ProcessId: ' + process.pid);

                    webApp.post('/alexa-tts', urlencodedParser, function(req, res) {
                        let hubAct = (req.headers.tts !== undefined || req.headers.deviceserialnumber !== undefined);
                        let tts = req.body.tts || req.headers.tts;
                        let deviceSerialNumber = req.body.deviceSerialNumber || req.headers.deviceserialnumber;
                        tsLogger('++ Received a Send TTS Request for Device: ' + deviceSerialNumber + ' | Message: ' + tts + (hubAct ? ' | Source: (ST HubAction)' : '') + ' ++');
                        alexa_api.setTTS(tts, deviceSerialNumber, savedConfig, function(error, response) {
                            res.send(response);
                        });
                    });

                    webApp.post('/alexa-getDevices', urlencodedParser, function(req, res) {
                        console.log('++ Received a getDevices Request...  ++');
                        alexa_api.getDevices(savedConfig, function(error, response) {
                            buildEchoDeviceMap(response.devices)
                                .then(function(devOk) {
                                    res.send(echoDevices);
                                })
                                .catch(function(err) {
                                    res.send(null);
                                });
                        });
                    });

                    webApp.post('/alexa-getState', urlencodedParser, function(req, res) {
                        let hubAct = (req.headers.deviceserialnumber != undefined);
                        let deviceSerialNumber = req.body.deviceSerialNumber || req.headers.echodeviceid;
                        console.log('++ Received a Device State Request for Device: ' + deviceSerialNumber + (hubAct ? ' | Source: (ST HubAction)' : '') + ' ++');
                        alexa_api.getState(deviceSerialNumber, savedConfig, function(error, response) {
                            res.send(response);
                        });
                    });

                    webApp.post('/alexa-getActivities', urlencodedParser, function(req, res) {
                        console.log('got request for getActivities');
                        alexa_api.getActivities(savedConfig, function(error, response) {
                            res.send(response);
                        });
                    });

                    webApp.post('/alexa-setMedia', urlencodedParser, function(req, res) {
                        var volume = req.body.volume;
                        var deviceSerialNumber = req.body.deviceSerialNumber;
                        if (volume) {
                            command = {
                                type: 'VolumeLevelCommand',
                                volumeLevel: parseInt(volume)
                            };
                        } else {
                            command = {
                                type: req.body.command
                            };
                        }
                        console.log('got set media message with command: ' + command + ' for device: ' + deviceSerialNumber);
                        alexa_api.setMedia(command, deviceSerialNumber, savedConfig, function(error, response) {
                            res.send(response);
                        });
                    });

                    webApp.post('/alexa-setBluetooth', urlencodedParser, function(req, res) {
                        var mac = req.body.mac;
                        var deviceSerialNumber = req.body.deviceSerialNumber;
                        console.log('got set bluetooth  message with mac: ' + mac + ' for device: ' + deviceSerialNumber);
                        alexa_api.setBluetoothDevice(mac, deviceSerialNumber, savedConfig, function(error, response) {
                            res.send(response);
                        });
                    });

                    webApp.post('/alexa-getBluetooth', urlencodedParser, function(req, res) {
                        console.log('got get bluetootha message');
                        alexa_api.getBluetoothDevices(savedConfig, function(error, response) {
                            res.send(response);
                        });
                    });

                    webApp.post('/alexa-disconnectBluetooth', urlencodedParser, function(req, res) {
                        var deviceSerialNumber = req.body.deviceSerialNumber;
                        console.log('got set bluetooth disconnect for device: ' + deviceSerialNumber);
                        alexa_api.disconnectBluetoothDevice(deviceSerialNumber, savedConfig, function(error, response) {
                            res.send(response);
                        });
                    });

                    //Returns Status of Service
                    webApp.post('/sendStatusUpdate', urlencodedParser, function(req, res) {
                        tsLogger('++ SmartThings is Requesting Device Data Update... | PID: ' + process.pid + ' ++');
                        res.send(0);
                        sendStatusUpdateToST(alexa_api);
                    });

                    webApp.post('/updateSettings', function(req, res) {
                        tsLogger('** Settings Update Received from SmartThings **');
                        if (req.headers.refreshseconds !== undefined && parseInt(req.headers.refreshseconds) !== configData.refreshSeconds) {
                            tsLogger('++ Changed Setting (refreshSeconds) | New Value: (' + req.headers.refreshseconds + ') | Old Value: (' + configData.refreshSeconds + ') ++');
                            configData.refreshSeconds = parseInt(req.headers.refreshseconds);
                            configFile.set('refreshSeconds', parseInt(req.headers.refreshseconds));
                            clearInterval(scheduledDataUpdates);
                            tsLogger("** Device Data Refresh Schedule Changed to Every (" + configData.refreshSeconds + ' sec) **');
                            setInterval(scheduledDataUpdates, configData.refreshSeconds * 1000);
                        }
                        if (req.headers.smartthingshubip !== undefined && req.headers.smartthingshubip !== configData.smartThingsHubIP) {
                            tsLogger('++ Changed Setting (smartThingsHubIP) | New Value: (' + req.headers.smartthingshubip + ') | Old Value: (' + configData.smartThingsHubIP + ') ++');
                            configFile.set('smartThingsHubIP', req.headers.smartthingshubip);
                            configData.smartThingsHubIP = req.headers.smartthingshubip;
                        }
                        configFile.save();
                    });
                    // if (Object.keys(echoDevices).length) {
                    // console.log(echoDevices);
                    sendDeviceDataToST(echoDevices);
                    tsLogger("** Device Data Refresh Scheduled for Every (" + configData.refreshSeconds + ' sec) **');
                    setInterval(scheduledDataUpdates, configData.refreshSeconds * 1000);
                    scheduledUpdatesActive = true;
                    // }
                })
                .catch(function(err) {
                    console.log(err);
                });
        }
    });
}

async function buildEchoDeviceMap(eDevData) {
    // console.log('eDevData: ', eDevData);
    try {
        let removeKeys = ['appDeviceList', 'charging', 'clusterMembers', 'essid', 'macAddress', 'parentClusters', 'deviceTypeFriendlyName', 'registrationId', 'remainingBatteryLevel', 'postalCode', 'language'];
        for (const dev in eDevData) {
            if (eDevData[dev].deviceFamily === 'ECHO' || eDevData[dev].deviceFamily === 'KNIGHT') {
                for (const item in removeKeys) {
                    delete eDevData[dev][removeKeys[item]];
                }
                echoDevices[eDevData[dev].serialNumber] = eDevData[dev];
                let devState = await getDeviceStateInfo(eDevData[dev].serialNumber);
                echoDevices[eDevData[dev].serialNumber].playerState = devState;
            }
        }
    } catch (err) {
        logger.error('buildEchoDeviceMap ERROR:', err);
    }
}

function getDeviceStateInfo(deviceId) {
    return new Promise(resolve => {
        alexa_api.getState(deviceId, savedConfig, function(err, resp) {
            resolve(resp.playerInfo || {});
        });
    });
}

function sendDeviceDataToST(eDevData) {
    try {
        buildEchoDeviceMap(eDevData)
            .then(function(devOk) {
                let options = {
                    method: 'POST',
                    uri: 'http://' + configData.smartThingsHubIP + ':39500/event',
                    headers: {
                        'evtSource': 'Echo_Speaks',
                        'evtType': 'sendStatusData'
                    },
                    body: {
                        'echoDevices': echoDevices,
                        'timestamp': Date.now(),
                        'serviceInfo': {
                            'version': appVer,
                            'sessionEvts': eventCount,
                            'startupDt': getServiceUptime(),
                            'ip': getIPAddress(),
                            'port': configData.serverPort,
                            'config': {
                                'refreshSeconds': configData.refreshSeconds,
                                'smartThingsHubIP': configData.smartThingsHubIP
                            }
                        }
                    },
                    json: true
                };
                // reqPromise(options)
                //     .then(function() {
                //         eventCount++;
                //         logger.info('** Sent Echo Speaks Data to SmartThings Hub Successfully! **');
                //     })
                //     .catch(function(err) {
                //         logger.error("ERROR: Unable to connect to SmartThings Hub: " + err.message);
                //     });
            })
            .catch(function(err) {
                logger.error(err.message);
            });
    } catch (err) {
        logger.error('sendStatusUpdateToST Error: ' + err.message);
    }
}

function sendStatusUpdateToST(self) {
    self.getDevices(savedConfig, function(error, response) {
        try {
            buildEchoDeviceMap(response.devices)
                .then(function(devOk) {
                    let options = {
                        method: 'POST',
                        uri: 'http://' + configData.smartThingsHubIP + ':39500/event',
                        headers: {
                            'evtSource': 'Echo_Speaks',
                            'evtType': 'sendStatusData'
                        },
                        body: {
                            'echoDevices': echoDevices,
                            'timestamp': Date.now(),
                            'serviceInfo': {
                                'version': appVer,
                                'sessionEvts': eventCount,
                                'startupDt': getServiceUptime(),
                                'ip': getIPAddress(),
                                'port': configData.serverPort,
                                'config': {
                                    'refreshSeconds': configData.refreshSeconds,
                                    'smartThingsHubIP': configData.smartThingsHubIP
                                }
                            }
                        },
                        json: true
                    }
                    logger.debug('echoDevices (statUpd): ' + Object.keys(echoDevices).length + ' devices');
                    // reqPromise(options)
                    //     .then(function() {
                    //         eventCount++;
                    //         logger.info('** Sent Echo Speaks Data to SmartThings Hub Successfully! **');
                    //     })
                    //     .catch(function(err) {
                    //         logger.error("ERROR: Unable to connect to SmartThings Hub: " + err.message);
                    //     });
                })
                .catch(function(err) {
                    logger.error('sendStatusUpdateToST Error: ' + err.message);
                });
        } catch (err) {
            logger.error('sendStatusUpdateToST Error: ' + err.message);
        }
    });
}

function scheduledDataUpdates() {
    sendStatusUpdateToST(alexa_api);
}

function configCheckOk() {
    return (configData.user === '' || configData.password === '' || configData.url === '') ? false : true
}

startWebConfig()
    .then(function(res) {
        if (configCheckOk()) {
            logger.info('-- Echo Speaks Web Service Starting Up! Takes about 10 seconds before it\'s available... --');
            startWebServer();
        }
    })
    .catch(function(err) {
        logger.error("## Start Web Config Error: " + err.message);
    });


/*******************************************************************************
                            SYSTEM INFO FUNCTIONS
********************************************************************************/

function tsLogger(msg) {
    let dt = new Date().toLocaleString();
    console.log(dt + ' | ' + msg);
}

function getIPAddress() {
    let interfaces = os.networkInterfaces();
    for (const devName in interfaces) {
        let iface = interfaces[devName];
        for (var i = 0; i < iface.length; i++) {
            let alias = iface[i];
            if (alias.family === 'IPv4' && alias.address !== '127.0.0.1' && !alias.internal) {
                return alias.address;
            }
        }
    }
    return '0.0.0.0';
}

function getServiceUptime() {
    let now = Date.now();
    let diff = (now - serviceStartTime) / 1000;
    //logger.debug("diff: "+ diff);
    return getHostUptimeStr(diff);
}

function getHostUptimeStr(time) {
    let years = Math.floor(time / 31536000);
    time -= years * 31536000;
    let months = Math.floor(time / 31536000);
    time -= months * 2592000;
    let days = Math.floor(time / 86400);
    time -= days * 86400;
    let hours = Math.floor(time / 3600);
    time -= hours * 3600;
    let minutes = Math.floor(time / 60);
    time -= minutes * 60;
    let seconds = parseInt(time % 60, 10);
    return {
        'y': years,
        'mn': months,
        'd': days,
        'h': hours,
        'm': minutes,
        's': seconds
    };
}

/*******************************************************************************
                            PROCESS EXIT FUNCTIONS
********************************************************************************/
//so the program will not close instantly
process.stdin.resume();
//do something when app is closing
process.on('exit', exitHandler.bind(null, {
    cleanup: true
}));
//catches ctrl+c event
process.on('SIGINT', exitHandler.bind(null, {
    exit: true
}));
process.on('SIGUSR2', exitHandler.bind(null, {
    exit: true
}));
process.on('SIGHUP', exitHandler.bind(null, {
    exit: true
}));
process.on('SIGTERM', exitHandler.bind(null, {
    exit: true
}));
process.on('uncaughtException', exitHandler.bind(null, {
    exit: true
}));

function exitHandler(options, exitCode) {
    alexaCookie.stopProxyServer();
    if (scheduledUpdatesActive) {
        clearInterval(scheduledDataUpdates);
    }
    if (options.cleanup) {
        console.log('clean');
    }
    if (exitCode || exitCode === 0) {
        console.log(exitCode);
    }
    if (options.exit) {
        process.exit();
    }
    console.log('graceful setting timeout for PID: ' + process.pid);
    setTimeout(function() {
        console.error("Could not close connections in time, forcefully shutting down");
        process.exit(1);
    }, 2 * 1000);
}