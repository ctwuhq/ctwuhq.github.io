(function() {
    var corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Origin, X-Requested-With, Content-Type, Accept, Authorization'
    };
  
    Object.keys(corsHeaders).forEach(function(header) {
      document.cookie = header + '='+ corsHeaders[header] + ';';
    });
  })();