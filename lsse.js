var async = require("async");

var ObjectID = require('mongodb').ObjectID;

var LSSE = function(){
	this.words = null;
	this.relations = null;
	this.lemms = null;
};

LSSE.prototype.getLemma = function(word, callback){

	this.lemms.find({forms: word}).toArray(function(err, items){
		if (err)
		{
			callback([]);
			return;
		}
		var lemms = [];
		var i;
		for(i = 0; i < items.length; i++)
		{
			lemms.push(items[i].lemma);
		}
		callback(lemms);
	});
};

LSSE.prototype.getBestRelations = function(word, model, limit, callback){
	var t = this;

	this.getLemma(word, function(lemms){
		if (lemms.length == 0)
			 lemms = [word];
		else if (lemms.indexOf(word) == -1)
			lemms.unshift(word);

		async.map(lemms, function(lemma, callback){
			t.loadRelations(lemma, model, callback);
		}, function(err, results){
			if (err)
			{
				callback(err);
				return;
			}
			var maxResuls = 0;
			var maxNumber = -1;
			var i;

			for(i = 0; i < results.length; i++)
			{
				if (results[i] && results[i].totalRelations > maxResuls)
				{
					maxResuls = results[i].totalRelations;
					maxNumber = i;
				}
			}
			if (maxNumber == -1)
			{
				callback(null, null);
				return;
			}
			var item = results[maxNumber];
			if (typeof limit != "undefined" && (limit = +limit) > 0)
			{
				item.relations.sort(function(a, b){
					return b.value - a.value;
				});
				item.relations.splice(limit, item.totalRelations - limit);
			}

			t.loadRelationsWords(item, function(err){
				if (err)
				{
					callback(err)
					return;
				}
				callback(null, item);
			});
		});
	});
}

LSSE.prototype.getRelations = function(word, model, limit, callback){
	var t = this;
	this.loadRelations(word, model, function(err, item){
		if (err)
		{
			callback(err)
			return;
		}
		if (!item)
		{
			callback(null, null);
			return;
		}
		if (typeof limit != "undefined" && (limit = +limit) > 0)
		{
			item.relations.sort(function(a, b){
				return b.value - a.value;
			});
			item.relations.splice(limit, item.totalRelations - limit);
		}

		t.loadRelationsWords(item, function(err){
			if (err)
			{
				callback(err)
				return;
			}
			callback(null, item);
		});
	});
};

LSSE.prototype.loadRelations = function(word, model, callback){
	var t = this;
	this.words.find({word: {$in: [word, model]}}).toArray(function(err, items){
		if (err)
		{
			callback(err)
			return;
		}

		var i, wordId = -1, modelId = -1;
		for(i = 0; i < items.length; i++)
		{
			if (items[i].word == word)
				wordId = i;
			else
			if (items[i].word == model)
				modelId = i;
		}
		if (wordId < 0 || modelId < 0)
		{
			callback(null);
			return;
		}
		t.relations.findOne({word: items[wordId].id, model: items[modelId].id}, function(err, item){
			if (err)
			{
				callback(err)
				return;
			}
			if (!item)
			{
				callback(null, null);
				return;
			}
			item.word = items[wordId].word;
			item.model = items[modelId].word;
			item.totalRelations = item.relations.length;

			callback(null, item);
		});
	});
};

LSSE.prototype.loadRelationsWords = function(item, callback){
	var needWords = [];
	var rel = item.relations;
	for(i = 0; i < rel.length; i++)
	{
		needWords.push(rel[i].word);
	}
	this.words.find({id: {$in: needWords}}).toArray(function(err, items){
		if (err)
		{
			callback(err);
			return;
		}
		var i = 0, j = 0;
		var wordsLength = items.length;
		var length = item.relations.length;

		for(i = 0; i < length; i++)
		{
			for(j = 0; j < wordsLength; j++)
			{
				if (items[j].id == rel[i].word)
				{
					rel[i].word = items[j].word;
					rel[i].icon = !!items[j].icon;
					
					items.splice(j, 1);
					wordsLength--;
				}
			}
		}
		
		callback(null);
	});
}

LSSE.prototype.openDb = function(database, callback){

	database.open(this.dbOpened.bind({
		callback: callback,
		lsse: this
	}));
};
LSSE.prototype.dbOpened = function(err, db){
	if (err)
	{
		this.callback(err);
		return;
	}

	var t = this;
	var collestions = ['words', 'relations', 'lemms'];
	async.map(collestions, db.collection.bind(db), function(err, results){
		if (err)
		{
			t.callback(err);
			return;
		}
		var i;
		for(i = 0; i < collestions.length; i++)
		{
			t.lsse[collestions[i]] = results[i];
		}
		t.callback(null);
	});
};

LSSE.prototype.suggest = function(word, limit, callback)
{

	this.words.find({word: new RegExp('^'+ word.replace(/[^a-zA-Z0-9]/, ''))}, {word: 1, freq: 1})
				.sort({freq: -1, word: 1}).limit(limit).toArray(function(err, items){
		if (err)
		{
			callback([])
			return;
		}
		var result = [];
		for(var i = 0; i < items.length; i++)
		{
			result.push(items[i].word);
		}
		callback(result);
	});
}

module.exports = LSSE;