'use strict';

var serialize = require('./util').serialize
var Tensor = require('./tensor');
var fs = require('fs');
var child_process = require('child_process');

module.exports = function(env) {

  function display(s, k, a, x) {
    return k(s, console.log(x));
  }

  // Caching for a wppl function f.
  //
  // Caution: if f isn't deterministic weird stuff can happen, since
  // caching is across all uses of f, even in different execuation
  // paths.
  function cache(s, k, a, f) {
    var c = {};
    var cf = function(s, k, a) {
      var args = Array.prototype.slice.call(arguments, 3);
      var stringedArgs = serialize(args);
      if (stringedArgs in c) {
        return k(s, c[stringedArgs]);
      } else {
        var newk = function(s, r) {
          if (stringedArgs in c) {
            // This can happen when cache is used on recursive functions
            console.log('Already in cache:', stringedArgs);
            if (serialize(c[stringedArgs]) !== serialize(r)) {
              console.log('OLD AND NEW CACHE VALUE DIFFER!');
              console.log('Old value:', c[stringedArgs]);
              console.log('New value:', r);
            }
          }
          c[stringedArgs] = r;
          return k(s, r);
        };
        return f.apply(this, [s, newk, a].concat(args));
      }
    };
    return k(s, cf);
  }

  function apply(s, k, a, wpplFn, args) {
    return wpplFn.apply(global, [s, k, a].concat(args));
  }

  // Annotating a function object with its lexical id and
  //    a list of its free variable values.
  var __uniqueid = 0;
  var _Fn = {
    tag: function(fn, lexid, freevarvals) {
      fn.__lexid = lexid;
      fn.__uniqueid = __uniqueid++;
      fn.__freeVarVals = freevarvals;
      return fn;
    }
  };

  var Vector = function(s, k, a, arr) {
    return k(s, new Tensor([arr.length, 1]).fromFlatArray(arr));
  };

  var Matrix = function(s, k, a, arr) {
    return k(s, new Tensor([arr.length, arr[0].length]).fromArray(arr));
  };

  var zeros = function(s, k, a, dims) {
    return k(s, new Tensor(dims));
  };

  var readJSON = function(s, k, a, fn) {
    return k(s, JSON.parse(fs.readFileSync(fn, 'utf-8')));
  };

  var writeJSON = function(s, k, a, fn, obj) {
    return k(s, fs.writeFileSync(fn, JSON.stringify(obj)));
  };

  var readJSONDataSet = function(s, k, a, fn) {
    var arr = JSON.parse(fs.readFileSync(fn, 'utf-8'));
    // Helper to avoid performing map over large data sets in WebPPL.
    // See #174.
    return k(s, arr.map(function(x) {
      return new Tensor([x.length, 1]).fromFlatArray(x);
    }));
  };

  var exec = function(s, k, a, cmd) {
    return k(s, child_process.execSync(cmd).toString());
  };

  return {
    display: display,
    cache: cache,
    apply: apply,
    _Fn: _Fn,
    Vector: Vector,
    Matrix: Matrix,
    zeros: zeros,
    readJSON: readJSON,
    writeJSON: writeJSON,
    readJSONDataSet: readJSONDataSet,
    exec: exec
  };

};
