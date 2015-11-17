'use strict';

var _ = require('underscore');
var numeric = require('numeric');
var assert = require('assert');
var util = require('../util.js');
var Histogram = require('../aggregation').Histogram;

var logLevel = parseInt(process.env.LOG_LEVEL) || 2;

function logger(level) {
  if (logLevel >= level) {
    console.log.apply(console, _.toArray(arguments).slice(1));
  }
}

var log = _.partial(logger, 0);
var info = _.partial(logger, 1);
var debug = _.partial(logger, 2);
var trace = _.partial(logger, 3);

module.exports = function(env) {

  function Variational(s, k, a, wpplFn, options) {
    var options = util.mergeDefaults(options, {
      steps: 100,
      stepSize: 0.001,
      samplesPerStep: 100,
      returnSamples: 1000
    });

    this.steps = options.steps;
    this.stepSize = options.stepSize;
    this.samplesPerStep = options.samplesPerStep;
    this.returnSamples = options.returnSamples;

    this.s = s;
    this.k = k;
    this.a = a;
    this.wpplFn = wpplFn;

    this.coroutine = env.coroutine;
    env.coroutine = this;
  }

  Variational.prototype.run = function() {

    var optimize = gd(this.stepSize);
    //var optimize = adagrad(this.stepSize);

    // TODO: Tensor values params?
    // All variational parameters. Maps addresses to numbers/reals.
    this.params = Object.create(null);

    return util.cpsLoop(
      this.steps,
      function(i, nextStep) {
        trace('\n********************************************************************************');
        info('Step: ' + i);
        trace('********************************************************************************\n');

        // Acuumulate gradients for this step.
        // Maps addresses to gradients.
        this.grad = Object.create(null);

        // Accumulate an estimate of the lower-bound.
        this.estELBO = 0;

        return util.cpsLoop(
          this.samplesPerStep,
          function(j, nextSample) {
            trace('\n--------------------------------------------------------------------------------');
            trace('Sample: ' + j);
            trace('--------------------------------------------------------------------------------\n');

            // Run the program.
            this.logp = 0;
            this.logq = 0;

            // Params seen this execution.
            // Maps addresses to tapes.
            this.paramsSeen = Object.create(null);

            return this.wpplFn(_.clone(this.s), function(s, val) {
              trace('Program returned: ' + val);
              trace('logp: ' + ad.untapify(this.logp));
              trace('logq: ' + ad.untapify(this.logq));

              var scoreDiff = ad.untapify(this.logq) - ad.untapify(this.logp);
              this.estELBO -= scoreDiff / this.samplesPerStep;

              // Initialize gradients to zero.
              _.each(this.paramsSeen, function(val, a) {
                if (!_.has(this.grad, a)) {
                  this.grad[a] = 0;
                }
              }, this);

              // Compute gradient w.r.t log q.
              ad.yGradientR(this.logq);
              _.each(this.paramsSeen, function(val, a) {
                assert(_.has(this.grad, a));
                trace('Score gradient of log q w.r.t. ' + a + ': ' + val.sensitivity);
                this.grad[a] += (val.sensitivity * scoreDiff) / this.samplesPerStep;
              }, this);

              // TODO: Is there a better way to handle this?

              // It might be the case that logp doesn't depend on all
              // parameters. We reset sensitivities here so that
              // parameters which aren't affected by yGradientR(logp)
              // have sensitivity 0 rather than the sensitivity left
              // over from yGradientR(logp).
              resetSensitivities(this.logq);

              // Compute gradient w.r.t log p.
              ad.yGradientR(this.logp);
              _.each(this.paramsSeen, function(val, a) {
                assert(_.has(this.grad, a)); // Initialized while accumulating grad. log p term.
                trace('Score gradient of log p w.r.t. ' + a + ': ' + val.sensitivity);
                this.grad[a] -= val.sensitivity / this.samplesPerStep;
              }, this);


              return nextSample();
            }.bind(this), this.a);


          }.bind(this),
          function() {

            // Take gradient step.
            trace('\n================================================================================');
            trace('Taking gradient step');
            trace('================================================================================\n');
            debug('Estimated ELBO before gradient step: ' + this.estELBO);

            trace('Params before step:');
            trace(this.params);

            optimize(this.params, this.grad);

            trace('Params after step:');
            debug(this.params);

            return nextStep();
          }.bind(this));

      }.bind(this),
      this.finish.bind(this));
  };


  function gd(stepSize) {
    return function(params, grad) {
      _.each(grad, function(g, a) {
        assert(_.has(params, a));
        params[a] -= stepSize * g;
      });
    };
  }
  
  function adagrad(stepSize) {
    // State.
    // Map from a to running sum of grad^2.
    var g2 = Object.create(null);
    return function(params, grad) {
      _.each(grad, function(g, a) {
        assert(_.has(params, a));
        if (!_.has(g2, a)) {
          g2[a] = 0;
        }
        g2[a] += Math.pow(g, 2);
        params[a] -= (stepSize / Math.sqrt(g2[a])) * g;
      });
    };
  }

  Variational.prototype.finish = function() {
    // Build distribution and compute final estimate of ELBO.
    var hist = new Histogram();
    var estELBO = 0;

    return util.cpsLoop(
      this.returnSamples,
      function(i, next) {
        this.logp = 0;
        this.logq = 0;
        return this.wpplFn(_.clone(this.s), function(s, val) {
          var scoreDiff = ad.untapify(this.logq) - this.logp;
          estELBO -= scoreDiff / this.returnSamples;
          hist.add(val);
          return next();
        }.bind(this), this.a);
      }.bind(this),
      function() {
        info('\n================================================================================');
        info('Estimated ELBO: ' + estELBO);
        info('\nOptimized variational parameters:');
        info(this.params);
        env.coroutine = this.coroutine;
        var erp = hist.toERP();
        erp.estELBO = estELBO;
        erp.parameters = this.params;
        return this.k(this.s, erp);
      }.bind(this));
  };

  function isTape(obj) {
    return _.has(obj, 'sensitivity');
  }

  function resetSensitivities(tape) {
    if (isTape(tape)) {
      tape.sensitivity = 0;
      _.each(tape.tapes, resetSensitivities);
    }
  }

  // TODO: This options arg clashes with the forceSample arg used in MH.
  Variational.prototype.sample = function(s, k, a, erp, params, options) {
    var options = options || {};
    // Assume 1-to-1 correspondence between guide and target for now.

    if (!_.has(options, 'guideVal')) {
      throw 'No guide value given';
    }

    // Update log p.
    var val = options.guideVal;
    // Untapify as logp can depend on the variational parameters via
    // its parameters, but it shouldn't depend on the parameters via
    // the value sampled from q. (I'm thinking of exo.wppl here, and
    // I'm not 100% sure yet.)
    var _val = ad.untapify(val);
    trace('Using guide value ' + _val + ' for ' + a + ' (' + erp.name + ')');
    this.logp = ad.add(this.logp, erp.score(params, _val));
    return k(s, val); // _val or val?
  };

  Variational.prototype.factor = function(s, k, a, score) {
    // Update log p.
    this.logp = ad.add(this.logp, score);
    return k(s);
  };

  Variational.prototype.paramChoice = function(s, k, a, erp, params) {
    if (!_.has(this.params, a)) {
      // New parameter.
      var _val = erp.sample(params);
      this.params[a] = _val;
      trace('Initialized parameter ' + a + ' to ' + _val);
    } else {
      _val = this.params[a];
      trace('Seen parameter ' + a + ' before. Value is: ' + _val);
    }
    var val = ad.tapify(_val);
    this.paramsSeen[a] = val;
    return k(s, val);
  };

  Variational.prototype.sampleGuide = function(s, k, a, erp, params) {
    // Sample from q.
    // Update log q.
    // What if a random choice from p is given as a param?
    var _params = ad.untapify(params);
    var val = erp.sample(_params);
    this.logq = ad.add(this.logq, erp.score(params, val));
    trace('Sampled ' + val + ' for ' + a + ' (' + erp.name + ' with params = ' + JSON.stringify(_params) + ')');
    return k(s, val);
  };

  function paramChoice(s, k, a, erp, params) {
    assert.ok(env.coroutine instanceof Variational);
    return env.coroutine.paramChoice(s, k, a, erp, params);
  }

  function sampleGuide(s, k, a, erp, params) {
    assert.ok(env.coroutine instanceof Variational);
    return env.coroutine.sampleGuide(s, k, a, erp, params);
  }

  Variational.prototype.incrementalize = env.defaultCoroutine.incrementalize;

  return {
    Variational: function(s, k, a, wpplFn, options) {
      return new Variational(s, k, a, wpplFn, options).run();
    },
    paramChoice: paramChoice,
    sampleGuide: sampleGuide
  };

};
