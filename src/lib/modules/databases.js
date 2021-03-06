var Promise = require('bluebird');
var common = require('../../lib/common.js');
var fs = require('fs');
var keys = Object.keys || require('object-keys');
var marklogic = require('marklogic');
var mlutil = require('marklogic/lib/mlutil.js');
var recursive = require('recursive-readdir');
var util = require('../../lib/utils.js');
var logger = util.consoleLogger;

var DBManager = module.exports;

DBManager.databaseOperation = function(operation, database) {
    var manager = this.getHttpManager();
    return new Promise(function(resolve, reject){
        //Issue command
        manager.post({
            endpoint: '/manage/LATEST/databases/' + database,
            body: { 'operation' : operation }
        }).then(function(resp) {
            resp.result(function(response) {
                if (response.statusCode === 200) {
                    resolve(database);
                } else {
                    logger.error(response.data.errorResponse.message);
                    reject('Error when issuing database operation '+operation+' at '+database+' [Error '+response.statusCode+']');
                }
            });
        });
    });
};

DBManager.getDatabaseProperties = function(database) {
    var manager = this.getHttpManager();
    return new Promise(function(resolve, reject){
        //Issue command
        manager.get({
            endpoint: '/manage/LATEST/databases/' + database + '/properties?format=json'
        }).then(function(resp) {
            resp.result(function(response) {
                if (response.statusCode === 200) {
                    resolve(response.data);
                } else if (response.statusCode === 404) {
                    resolve();
                } else {
                    logger.error(response.data.errorResponse.message);
                    reject('Error when fetching database properties at '+database+' [Error '+response.statusCode+']');
                }
            });
        });
    });
};

DBManager.buildDatabase = function(settings, type) {
    var BASE_SERVER_URL = '/manage/LATEST/databases';
    var UPDATE_SERVER_URL = BASE_SERVER_URL + '/' + settings['database-name'];
    var manager = this.getHttpManager();
    return new Promise(function(resolve, reject){
        //Check if server exists
        manager.get({
            endpoint: UPDATE_SERVER_URL
        }).then(function(resp) {
            resp.result(function(response) {
                if (response.statusCode === 404) {
                    //database not found
                    //let's create it
                    logger.info('Creating ' + type +  ' database');
                    manager.post(
                        {
                            endpoint : BASE_SERVER_URL,
                            body : settings
                        }).then(function(resp) {
                            resp.result(function(response) {
                                if (response.statusCode === 201) {
                                    resolve(type + " database created");
                                } else {
                                    logger.error(response.data.errorResponse.message);
                                    reject('Error when creating '+type+' database [Error '+response.statusCode+']');
                                }
                            });
                        });
                } else if (response.statusCode === 200) {
                    manager.put(
                        {
                            endpoint : UPDATE_SERVER_URL + '/properties',
                            body : settings
                        }).then(function(resp) {
                            resp.result(function(response) {
                                if (response.statusCode !== 204) {
                                    logger.error(response.data.errorResponse.message);
                                    reject('Error when updating '+type+' database [Error '+response.statusCode+']');
                                } else {
                                    resolve(type + " database updated");
                                }
                            });
                        });
                } else {
                    logger.error(response.data.errorResponse.message);
                    reject('Error when checking '+type+' database [Error '+response.statusCode+']');
                }

            });
        });
    });
};

DBManager.initializeDatabase = function(type) {
    var that = this;
    return new Promise(function(resolve, reject){
        var settings = common.objectSettings('databases/' + type, this.env);
        if (!Array.isArray(settings.forest)) {
            // settings.forest may be an object that contains a forests-per-host value.
            that.buildForestsByHost(settings).then(function(forestNames) {
                settings.forest = forestNames;
                that.buildDatabase(settings, type).then(function(msg){
                    resolve(msg);
                });
            });
        } else {
            that.buildDatabase(settings, type).then(function(msg){
                resolve(msg);
            });
        }
    });

};

DBManager.removeDatabase = function(type, removeForest) {
    var that = this;
    return new Promise(function(resolve, reject){
        //check removeForest value
        if (removeForest && !/(configuration|data)/i.test(removeForest)) {
            reject('Only configuration and data allowed for removeForest parameter');
        }
        var settings = common.objectSettings('databases/' + type, that.env);
        var SERVER_URL = '/manage/LATEST/databases/' + settings['database-name'];
        var manager = that.getHttpManager();
        //Check if server exists
        manager.get({
            endpoint: SERVER_URL
        }).then(function(resp) {
            resp.result(function(response) {
                if (response.statusCode === 200) {
                    manager.remove(
                        {
                            endpoint : SERVER_URL,
                            params : (removeForest ? { 'forest-delete' : removeForest } : undefined)
                        }).then(function(resp) {
                            resp.result(function(response) {
                                if (response.statusCode !== 204) {
                                    reject('Error when deleting '+type+' database [Error '+response.statusCode+']');
                                    logger.error(response.data.errorResponse.message);
                                }
                                resolve(type + ' database removed');
                            });
                        });
                } else if (response.statusCode === 404) {
                    //database already removed
                    resolve('Database already removed');
                } else {
                    logger.error(response.data.errorResponse.message);
                    reject('Error when deleting '+type+' database [Error '+response.statusCode+']');
                }
            });
        });
    });
};


DBManager.initializeRebalancer = function(type) {
    var that = this;
    var settings = common.objectSettings('databases/' + type, this.env);
    return new Promise(function(resolve, reject){
        that.initializeMultiObjects('database-rebalancer/partitions', 'partitions', 'partition-name', [], settings['schema-database'])
        .then(function(msg){
            return that.initializeMultiObjects('database-rebalancer/rebalancer', 'rebalancer', undefined, [], settings['schema-database'])
        })
        .then(function(msg){
            return that.initializeMultiObjects('database-rebalancer/partition-queries', 'partition-queries', 'partition-number', [], settings['schema-database'])
        })
        .then(function(msg){
            resolve(msg);
        });
    });
};

DBManager.loadDocuments = function(root, folder, database) {
    var that = this;
    return new Promise(function(resolve, reject){
        var settings = mlutil.copyProperties(that.settings.connection);
        //Need to connect to Rest API, not management one
        settings.port = that.httpSettings.port;
        settings.database = database;
        var db = marklogic.createDatabaseClient(settings);
        recursive(folder, function (err, files) {

            var callBackwhenDone = (function() {
                var total = files.length;
                return function() {
                    total = total-1;
                    if (total < 1) {
                        resolve('Successfully Loaded...');
                    }
                };
            })();

            if (err) {
                reject(folder + ' Folder not found');
            }
            if (files.length === 0) {
                resolve('Nothing to do');
            }
            files.forEach(function(file){
                var document = fs.readFileSync(file, 'utf8');
                db.documents.write(
                  {
                    uri: file.replace(new RegExp('^'+root),''),
                    content: document
                  }
                ).result(
                    function(response) {
                        callBackwhenDone();
                    },
                    function(error) {
                        reject('Error loading file ' + file);
                        logger.error(error);
                    }
                );
            });
        });
    });
};

DBManager.deployTriggers = function(database) {
    var that = this;
    logger.info("Deploying triggers");
    return new Promise(function(resolve, reject){
            that.getDatabaseProperties(database)
            .then(function(properties) {
                return that.initializeMultiObjects('triggers', 'triggers', 'name', undefined, properties["triggers-database"])
            })
            .then(function(msg){
                resolve(msg);
            }).catch(function(msg){
                reject(msg);
            });
    });

};

DBManager.deployCPF = function(database) {
    var that = this;
    logger.info("Deploying CPF");
    return new Promise(function(resolve, reject){
            that.getDatabaseProperties(database)
            .then(function(properties) {
               var database = properties["triggers-database"]
               var manager = that.getHttpManager();
               manager.post({
                    endpoint: '/manage/LATEST/databases/' + database + '/pipelines?format=json',
                    body: { 'operation' : 'load-default-cpf-pipelines' }
               }).then(function() {
                    return that.initializeMultiObjects('cpf/pipelines', 'pipelines', 'pipeline-name', undefined, database)
               }).then(function(msg){
                    return that.initializeMultiObjects('cpf/domains', 'domains', 'domain-name', undefined, database);
               /*}).then(function(msg){
                    return that.initializeMultiObjects('cpf/cpf-configs', 'cpf-configs', 'domain-name', undefined, database);
                   */
               }).then(function(msg){
                    resolve("CPF deployed");
               });
             }).catch(function(msg){
                 reject(msg);
            });
    });
};

DBManager.deployAlerts = function(database) {
    var that = this;
    logger.info("Deploying alerts");
    return new Promise(function(resolve, reject){
            that.initializeMultiObjects('alerts/configs', 'alert/configs', 'uri', undefined, database, '?uri=')
            .then(function(msg){
                 //ALERT Actions
                 var defs = that.getConfiguration('alerts/actions');
                 return new Promise(function(resolve, reject){
                        var callBackwhenDone = (function() {
                            var total = defs.length;
                            return function() {
                                total = total-1;
                                if (total < 1 ){
                                    resolve('Alerts configs Initialized');
                                }
                            };
                        })();

                        if (defs.length === 0) {
                            resolve('Nothing to do');
                        }
                        //Initilialize all
                        defs.forEach(function(item){
                            var settings = common.objectSettings('alerts/actions/' + item, that.env);
                            var BASE_SERVER_URL = '/manage/LATEST/databases/' + database + '/alert/actions' ;
                            var UPDATE_SERVER_URL = BASE_SERVER_URL + '/' + settings["name"];
                            var supported = ['name', 'description', 'module-db',
                                             'module-root', 'module', 'options'];
                            var manager = that.getHttpManager();
                            //Check if exists
                            manager.get({
                                endpoint: BASE_SERVER_URL + '/' + settings["name"] + '?uri=' + settings["alert-uri"]
                            }).then(function (resp) {
                                resp.result(function(response) {
                                    if (response.statusCode === 404) {
                                        /* does not exist. Create it */
                                       //only some of the properties are allowed on update. Remove non supported ones
                                       //Construct payload based on supported properties
                                       var payload = supported ? that.filterUnsupportedProperties(supported, settings) : settings;
                                       manager.post({
                                           endpoint : BASE_SERVER_URL + '?uri=' + settings["alert-uri"],
                                           body : payload
                                       }).then(function(resp) {
                                           resp.result(function(response) {
                                                if (response.statusCode === 201) {
                                                    callBackwhenDone();
                                                } else {
                                                    logger.error(response.data.errorResponse.message);
                                                    reject('Error when creating '+item+' [Error '+ response.statusCode +']');
                                                }
                                           });
                                       });
                                    } else if (response.statusCode === 200) {
                                       //Already present.
                                       //only some of the properties are allowed on update. Remove non supported ones
                                       //Construct payload based on supported properties
                                       var payload = supported ? that.filterUnsupportedProperties(supported, settings) : settings;
                                       if(keys(payload).length > 0){
                                           //There is something to send
                                           var endpoint = UPDATE_SERVER_URL + '/properties?uri=' + settings['alert-uri'];
                                           manager.put({
                                               endpoint: endpoint,
                                               body : payload
                                           }).then(function(resp) {
                                               resp.result(function(response) {
                                                    if (response.statusCode === 204) {
                                                        callBackwhenDone();
                                                    } else {
                                                        logger.error(response.data.errorResponse.message);
                                                        reject('Error when updating '+item+' [Error '+ response.statusCode +']');
                                                    }
                                               });
                                           });
                                       } else {
                                           //nothing to send. We are done with this
                                           callBackwhenDone();
                                       }
                                    } else {
                                        logger.error(response.data.errorResponse.message);
                                        reject('Error when checking '+item+' [Error '+ response.statusCode +']');
                                    }
                                });
                            });
                        });
                 })
                 .then(function(msg){
                    //ALERTS rules
                    var defs = that.getConfiguration('alerts/rules');
                    return new Promise(function(resolve, reject){
                        var callBackwhenDone = (function() {
                            var total = defs.length;
                            return function() {
                                total = total-1;
                                if (total < 1 ){
                                    resolve('Alerts rules Initialized');
                                }
                            };
                        })();

                        if (defs.length === 0) {
                            resolve('Nothing to do');
                        }
                        //Initilialize all
                        defs.forEach(function(item){
                            var settings = common.objectSettings('alerts/rules/' + item, that.env);
                            var BASE_SERVER_URL = '/manage/LATEST/databases/' + database + '/alert/actions/' + settings["action-name"] + '/rules';
                            var UPDATE_SERVER_URL = BASE_SERVER_URL;
                            var supported = ['name', 'description', 'user-id',
                                             'query', 'action-name', 'external-security-id',
                                             'user-name', 'options'];
                            var manager = that.getHttpManager();
                            //Check if exists
                            manager.get({
                                endpoint: BASE_SERVER_URL + '/' + settings["name"] + '?uri=' + settings["alert-uri"]
                            }).then(function (resp) {
                                resp.result(function(response) {
                                    if (response.statusCode === 404) {
                                        /* does not exist. Create it */
                                       manager.post({
                                           endpoint : BASE_SERVER_URL + '?uri=' + settings["alert-uri"],
                                           body : settings
                                       }).then(function(resp) {
                                           resp.result(function(response) {
                                                if (response.statusCode === 201) {
                                                    callBackwhenDone();
                                                } else {
                                                    logger.error(response.data.errorResponse.message);
                                                    reject('Error when creating '+item+' [Error '+ response.statusCode +']');
                                                }
                                           });
                                       });
                                    } else if (response.statusCode === 200) {
                                       //Already present.
                                       //only some of the properties are allowed on update. Remove non supported ones
                                       //Construct payload based on supported properties
                                       var payload = supported ? that.filterUnsupportedProperties(supported, settings) : settings;
                                       if(keys(payload).length > 0){
                                           //There is something to send
                                           var endpoint = UPDATE_SERVER_URL + '/' + settings["name"] + '/properties?uri=' + settings["alert-uri"];
                                           manager.put({
                                               endpoint: endpoint,
                                               body : payload
                                           }).then(function(resp) {
                                               resp.result(function(response) {
                                                    if (response.statusCode === 204) {
                                                        callBackwhenDone();
                                                    } else {
                                                        logger.error(response.data.errorResponse.message);
                                                        reject('Error when updating '+item+' [Error '+ response.statusCode +']');
                                                    }
                                               });
                                           });
                                       } else {
                                           //nothing to send. We are done with this
                                           callBackwhenDone();
                                       }
                                    } else {
                                        logger.error(response.data.errorResponse.message);
                                        reject('Error when checking '+item+' [Error '+ response.statusCode +']');
                                    }
                                });
                            });
                        });
                 });
            })
            .then(function(msg){
                resolve("Alerts deployed");
            }).catch(function(msg){
                reject(msg);
            });
    });

    });

};
