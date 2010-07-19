var EventEmitter = require('events').EventEmitter,
	Stream		 = require('net').Stream,
	Buffer		 = require('buffer').Buffer,
	CreateHash	 = require('crypto').createHash;

var HashRing 	 = require('./lib/hashring').HashRing,
	Connections  = require('./lib/connection'),
	Utils		 = require('./lib/utis'),
	Manager		 = Connection.Manager,
	IssueLog	 = Connection.IssueLog;

exports.Client = function Client( args, options ){
	var servers = [],
		weights = {},
		key;

	// parse down the connection arguments	
	switch( Object.prototype.toString.call( args ) ){
		case '[object String]':
			servers.push( args );
			break;
		case '[object Object]':
			weights = args;
			servers = Object.keys( args );
		case '[object Array]': 
		default:
			servers = args;
			break;
	}

	// merge with global and user config
	Utils.merge( this, Client.config );
	Utils.merge( this, options );
	EventEmitter.call( this );

	this.servers = servers;
	this.HashRing = new HashRing( servers, weights );
	this.connections = [];
	this.issues = [];
};

// Allows users to configure the memcached globally or per memcached client
Client.config = {
	max_key_size: 251,			 // max keysize allowed by Memcached
	max_expiration: 2592000,	 // max expiration duration allowed by Memcached
	max_value: 1048576,			 // max length of value allowed by Memcached

	pool_size: 10,				 // maximal parallel connections
	reconnect: 18000000,		 // if dead, attempt reconnect each xx ms
	retries: 5,					 // amount of retries before server is dead
	retry: 30000,				 // timeout between retries, all call will be marked as cache miss
	remove: false,				 // remove server if dead if false, we will attempt to reconnect

	compression_threshold: 10240,// only than will compression be usefull
	key_compression: true		 // compress keys if they are to large (md5)
};

// There some functions we don't want users to touch so we scope them
(function( nMemcached ){
	const FLUSH					= 1E3,
		  BUFFER				= 1E2,
		  CONTINUE				= 1E1
		  LINEBREAK				= '\r\n',
		  FLAG_JSON 			= 1<<1,
		  FLAG_COMPRESSION 		= 2<<1,
		  FLAG_JCOMPRESSION 	= 3<<1,
		  FLAG_BINARY 			= 4<<1,
		  FLAG_COMPRESSEDBINARY = 5<<1,
		  FLAG_ESCAPED			= 6<<1;

	var memcached = nMemcached.prototype = new EventEmitter;

	memcached.connect = function( server, callback ){
		if( server in this.issues && this.issues[ server ].failed )
			return callback( false, false );
		
		if( server in this.connections )
			return this.connections[ server ].allocate( callback );
		
		var server_tokens = /(.*):(\d+){1,}$/.exec( server ).reverse(),
			memcached = this;
			server_tokens.pop();
		
		this.connections[ server ] = new Manager( server, this.pool_size, function( callback ){
			var S = new Stream,
				Manager = this;
			
			// config the Stream
			S.setTimeout(0);
			S.setNoDelay(true);
			S.metaData = [];
			S.server = server;
			S.tokens = server_tokens;
			
			Utils.fuse( S, {
				connect	: function(){ callback( false, this ) },
				close	: function(){ Manager.remove( this ) },
				error	: function( err ){ memcached.connectionIssue( error, S, callback ) },
				data	: curry( memcached, memcached.rawDataReceived, S ),
				end		: S.end
			});
			
			// connect the net.Stream [ port, hostname ]
			S.connect.apply( S, server_tokens );
		});
		
		this.connections[ server ].allocate( callback );
	};
	
	memcached.command = function( query ){
		var server = this.HashRing.get_node( query.key );
		
		if( server in this.issues && this.issues[ server ].failed )
			return callback( false, false );
		
		this.connect( server, function( error, S ){
			if( !S ) return query.callback( false, false );
			if( error ) return query.callback( error );
			if( S.readyState !== 'open' ) return query.callback( 'Connection readyState is set to ' + S.readySate );
			
			S.metaData.push( query );
			S.write( query.command + LINEBREAK );
		})
	};
	
	memcached.connectionIssue = function( error, S, callback ){
		// end connection and mark callback as cache miss
		S.end(); callback( false, false );
		
		var issues,
			server = S.server,
			memcached = this;
		
		// check for existing issue logs, or create a new	
		if( server in this.issues ){
			issues = this.issues[ server ];
		} else {
			issues = this.issues[ server ] = new IssueLog({
				server: 	server,
				tokens: 	S.tokens,
				reconnect: 	this.reconnect,
				retries: 	this.retries,
				retry: 		this.retry,
				remove: 	this.remove
			});
			
			// proxy the events
			Utils.fuse( issues, {
				issue:			function( details ){ memcached.emit( 'issue', details ) },
				failure: 		function( details ){ memcached.emit( 'failure', details ) },
				reconnecting: 	function( details ){ memcached.emit( 'reconnecting', details ) },
				reconnected: 	function( details ){ memcached.emit( 'reconnect', details ) },
				remove: 		function( details ){
									// emit event and remove servers
									memcached.emit( 'remove', details );
									memcached.connections[ server ].end();
									
									if( this.failOverServers && this.failOverServers.length )
										memcached.HashRing.replaceServer( server, this.failOverServers.shift() );
									else
										memcached.HashRing.removeServer( server );
								}
			});
		}
		
		// log the issue
		issues.log( error );
	};
	
	memcached.disconnect = function(){
		this.connections.forEach(function( Manager ){ Manager.free(0) });
	};
	
	memcached.rawDataReceived.parsers = {
		// handle error respones
		NOT_FOUND: 		function( tokens, dataSet, err ){ return [ CONTINUE, false ] },
		NOT_STORED: 	function( tokens, dataSet, err ){ return [ CONTINUE, false ] },
		ERROR: 			function( tokens, dataSet, err ){ return [ CONTINUE, false ] },
		CLIENT_ERROR: 	function( tokens, dataSet, err ){ return [ CONTINUE, false ] },
		SERVER_ERROR: 	function( tokens, dataSet, err ){ return [ CONTINUE, false ] },
		
		// keyword based responses
		STORED: 		function( tokens, dataSet ){ return [ CONTINUE, true ] },
		DELETED: 		function( tokens, dataSet ){ return [ CONTINUE, true ] },
		OK: 			function( tokens, dataSet ){ return [ CONTINUE, true ] },
		EXISTS: 		function( tokens, dataSet ){ return [ CONTINUE, true ] },
		END: 			function( tokens, dataSet ){ return [ FLUSH, true ] },
		
		// value parsing:
		VALUE: 			function( tokens, dataSet ){},
		STAT: 			function( tokens, dataSet ){},
		VERSION:		function( tokens, dataSet ){
							var version_tokens = /(\d+)(?:\.)(\d+)(?:\.)(\d+)$/.exec( peices.shift() );
							return [ CONTINUE, 
									{ 
										version:version_tokens[0],
										major: 	version_tokens[1] || 0,
										minor: 	version_tokens[2] || 0,
										bugfix: version_tokens[3] || 0
									}];
						},
		
		// result set parsing
		STATS: function( resultSet ){}
	};
	
	memcached.rawDataReceived.commandReceived = new RegExp( '^(?:' + Object.keys( memcached.rawDataReceived.parsers ).join( '|' ) + ')' );
	
	memcached.rawDataReceived = function( Buffer, S ){
		var queue = [], buffer_chunks = Buffer.toString().split( LINEBREAK ),
			
			parsers = memcached.rawDataReceived.parsers,
			commandReceived = memcached.rawDataReceived.commandReceived,
			
			token, tokenSet, command, dataSet = '', resultSet, metaData;
			
		Buffer.pop(); // removes last empty item because all commands are ended with \r\n
		
		while( buffer_chunks.length ){
			token = buffer_chunks.pop();
			tokenSet = token.split( ' ' );
			
			// check for dedicated parser
			if( parsers[ tokenSet[0] ] ){
				/* @TODO gather the dataSet results, this should be fairly easy by doing a lookahead of the next piece of buffer
					and if it's not a command add it to our dataSet
				 	while( buffer_chunks.length ){
						if( commandReceived.test( buffer_chunks[0] ) )
							break;
						
						dataSet += ( LINEBREAK + buffer_chunks.pop() );
						
					}
				
				*/
				
				resultSet = parsers[ tokenSet[0] ]( tokenSet, dataset || token, err, queue );
				
				switch( resultSet.pop() ){
					case BUFFER:
						break;
						
					case FLUSH:
						metaData = S.metaData.shift();
						resultSet = queue;
						
						// see if optional parsing needs to be applied to make the result set more readable
						if( parsers[ metaData.type ] )
							resultSet = parsers[ metaData.type ]( resultSet, err );
							
						metaData.callback.call( metaData, [ err, resultSet ] );
						queue.length = 0;
						err = false;
						break;
						
					default:
						metaData = S.metaData.shift();
						metaData.callback.call( metaData, [ err, queue ] );
						err = false;
						break;
				}
			} else {
				// handle unkown responses
				metaData = S.metaData.shift();
				metaData.callback.call( metaData, [ 'Unknown response from the memcached server: ' + token, false ] );
			}
			
			// cleanup
			dataSet = ''
			tokenSet = undefined;
			metaData = undefined;
			command = undefined;
		}
	};
	
})( Client )