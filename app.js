var express = require('express')
	, routes = require('./routes')
	, http = require('http')
	, lingua  = require('lingua')
	, async = require('async')
	, request = require('request')
	, fs = require('fs');

var mysql = require('mysql');

var LSSE = require('./lsse');
var dbPedia = require('./dbpedia');
var lsse = new LSSE();

var LsseLogger = require('./logger');
var logger = new LsseLogger('logs');

var cfg = require('./config.js');

var app = express();

app.configure(function(){
	app.set('port', process.env.PORT || 80);
	app.set('views', __dirname + '/views');
	app.set('view engine', 'ejs');

	// Lingua configuration
    app.use(lingua(app, {
		defaultLocale: 'en',
		path: __dirname + '/i18n'
	}));

	app.use(function(req, res, next){
		res.locals.locale = res.lingua.locale;
		next();
	});

	app.use(function(req, res, next){
		res.locals.cfg = cfg;
		next();
	});

	app.use(express.favicon());
	app.use(express.logger('dev'));
	app.use(express.bodyParser());
	app.use(express.methodOverride());
	app.use(app.router);
	app.use(express.static(__dirname + '/public'));

});

app.configure('development', function(){
	app.use(express.errorHandler());
});

var wordsCollection = null;

var dataModels = require('./data_models').models;

app.get('/:lang(en|fr|ru)?', routes.page);

app.post('/sort/:word', function(req, res){
	dbPedia.sort(req.body.data, function(){
		res.send(req.body.data);
	});
});
app.get('/def/:word', function(req, res){

	dbPedia.getDefinition(req.params.word, function(err, result){
		if (!err && result != null)
		{
			res.send(result);
		}
		else
		{
			res.send({
				word: req.params.word, 
				definition: {
					en: null,
					ru: null
				},
				labels: {
					en: null,
					ru: null
				}, 
				image: null, 
				disambiguates: []
			});
		}
		//	res.send({en: null, ru: null, image: null, word: req.params.word});
		
	});
}); 
app.get('/:lang(en|fr|ru)?/page/:page', routes.page);

app.get('/:lang(en|fr|ru)?/suggest/:suggest', function(req, res){
	var searchWord = req.params.suggest.toLowerCase();
	var result = [searchWord, [], [], []];
	var hostName = req.headers['host'] || "serelex.it-claim.ru";
	lsse.suggest(searchWord, req.params.lang || "en", 20, function(words){
		var i, results = [];
		for(i = 0; i < words.length; i++)
		{
			result[1].push(words[i].word);
			result[2].push("");
			result[3].push("http://" + hostName + "/#" + words[i].word);
		}
		
		res.set('Content-Type', 'application/x-suggestions+json');
		res.send(JSON.stringify(result));
	});
});

var searchEngineInfoCache = {};
app.get('/SearchEngineInfo.xml', function(req, res){
	var hostName = req.headers['host'] || "serelex.it-claim.ru";
	if (searchEngineInfoCache.hasOwnProperty(hostName))
	{
		res.setHeader('Content-Type', 'application/opensearchdescription+xml');
		res.send(searchEngineInfoCache[hostName]);
	}	
	else
	{
		fs.readFile("./SearchEngineInfo.xml", "utf-8", function(err, data){
			if (err)
			{
				res.status(500).send();
				return;
			}
			res.setHeader('Content-Type', 'application/opensearchdescription+xml');
			searchEngineInfoCache[hostName] = data.replace(/{siteUrl}/g, hostName);
			res.send(searchEngineInfoCache[hostName]);
		});
	}
});

app.get('/:lang(en|fr|ru)?/find/:model/:word/:limit?/:skip?', function(req, res){
	
	var data = {
		time: (new Date()).getTime(),
		query: {
			model: req.params.model,
			word: req.params.word
		},
		user: {
			useragent: req.headers['user-agent'],
			ip: req.connection.remoteAddress + ":" + req.connection.remotePort,
			socket_id: req.headers['x-user-id'] || "API REQUEST"
		}
	}
	logger.writeLogEntry(data);

	lsse.getBestRelations(
		req.params.word.toLowerCase(), 
		req.params.model.toLowerCase(),
		cfg.models[req.params.model.toLowerCase()] || null,
		parseInt(req.params.limit), 
		parseInt(req.params.skip), 
		function(err, item) {

		if (err || !item)
		{
			res.send({word: req.params.word, model: req.params.model, totalRelations: 0});
			if (err)
				console.log(err);
		}
		else if (item)
		{
			res.send(item);
		}
		
	})
});

var modelsListForAPI = null;
app.get('/:db(en|fr|ru)?/models', function(req, res){

	if (modelsListForAPI == null)
	{
		var i;
		modelsListForAPI = [];
		for(i = 0; i < dataModels.length; i++)
		{
			modelsListForAPI.push({
				name: dataModels[i].name, 
				alias: dataModels[i].alias
			});
		}
	}
	res.send(modelsListForAPI);
});


var connection = mysql.createConnection(cfg.database);

lsse.openDb(connection, function(err){
	if (err)
	{
		console.log(err);
		return;
	}
	
	setInterval(function(){
		connection.ping();
	}, 1000 * 60 * 10);
	
	var server = http.createServer(app);

	server.listen(app.get('port'), function(){
		console.log("Express server listening on port " + app.get('port'));
	});
	var io = require('socket.io').listen(server);
	io.set('log level', 1); // 0 - error, 1 - warn, 2 - info, 3 - debug
	
	io.sockets.on('connection', function (socket) {
		socket.on('get relationships', function (data) {
			data.word = data.word.toString().toLowerCase();
			data.model = data.model.toString().toLowerCase();

			lsse.getBestRelations(data.word, data.model, cfg.models[data.model] || "en", data.limit, data.skip || 0, function(err, item){
				if (err)
				{
					console.log(err);
					socket.emit('result_' + data.searchId, {totalRelations: 0, word: data.word});
					return;
				}
				if (item)
				{
					item.word = data.word;
					socket.emit('result_' + data.searchId, item);
					return;
				}

				var words = [];
				
				var correctCost = {}
				var corrected = lsse.correctWord(data.word, 2);
				if (corrected.length > 0)
				{
					var i;
					for(i = 0; i < corrected.length && i < 60; i++)
					{
						words.push(corrected[i].word);
						correctCost[corrected[i].word + "123"] = corrected[i].cost;
					}	
				}
				else
				{
					words = lsse.getPerhaps(data.word);
				}
				// words = lsse.getPerhaps(data.word);
				async.map(words, function(word, callback){
					lsse.getLemma(word, cfg.models[data.model], callback)
				}, function(err, results){
				    var i, j;
				    for(i = 0; i < results.length; i++)
				    {
				    	for(j = 0; j < results[i].length; j++)
				    	{
				    		if (words.indexOf(results[i][j]) == -1)
				    			words.push(results[i][j]);
				    	}
				    }
				    // console.time("loadRel");
			    	async.map(words, function(word, callback){
						lsse.loadRelations(word, data.model, cfg.models[data.model], data.limit, data.skip || 0, callback);
					}, function(err, results){
						// console.timeEnd("loadRel");
						if (err)
						{
							console.log(err);
							socket.emit('result_' + data.searchId, {totalRelations: 0});
							return;
						}
						var perhaps = [], i;
						results.sort(function(a, b){
							if (!a)
								return 1;
							if (!b)
								return 0;
							var costA = correctCost[a.word + "123"];
							var costB = correctCost[b.word + "123"];

							if (costA && costB && costA != costB)
							{
								return costA - costB;
							}
							return b.totalRelations - a.totalRelations;
						});
						for(i = 0; i < results.length; i++)
						{
							if (results[i].totalRelations && perhaps.length < 10)
							{
								perhaps.push({
									word: results[i].word, 
									totalRelations: results[i].totalRelations
								});
							}
						}
						socket.emit('result_' + data.searchId, {totalRelations: 0, perhaps: perhaps, word: data.word});
					});

				});
			});
		});

		socket.on('log', function (data) {
			data.user = {
				ip: this.handshake.address.address + ":" + this.handshake.address.port,
				useragent: this.handshake.headers['user-agent'],
				socket_id: this.id
			}
			logger.writeLogEntry(data);
		});

		socket.on('suggest', function (data) {
			lsse.suggest(data.word.toLowerCase(), data.lang, 10, function(words){

				socket.emit('suggest result', words.map(function(item){return item.word}));
			})
		});

		socket.on('save relevance', function (data) {
			var address = this.handshake.address;
			lsse.saveRelevance(data.word, data.model, data.relevance, {
				ip: address.address + ":" + address.port,
				useragent: this.handshake.headers['user-agent'],
				time: Math.floor((new Date()).getTime()/1000)
			});
		});
	});
});
