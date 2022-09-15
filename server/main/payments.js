const Text = require('../../locales/index');

////////////////////////////////////////////////////////////////////////////////

// Main Payments Function
const Payments = function (logger, client, config, configMain) {

  const _this = this;
  this.logger = logger;
  this.client = client;
  this.config = config;
  this.configMain = configMain;
  this.pool = config.name;
  this.text = Text[configMain.language];

  // Database Variables
  this.executor = _this.client.commands.executor;
  this.current = _this.client.commands.pool;
  this.historical = _this.client.commands.historical;

  // Handle Historical Blocks Updates
  this.handleHistoricalBlocks = function(blocks) {

    // Return Blocks Updates
    return blocks.map((block) => {
      return {
        timestamp: Date.now(),
        miner: block.miner,
        worker: block.worker,
        category: block.category,
        confirmations: block.confirmations,
        difficulty: block.difficulty,
        hash: block.hash,
        height: block.height,
        identifier: block.identifier,
        luck: block.luck,
        reward: block.reward,
        round: block.round,
        solo: block.solo,
        transaction: block.transaction,
        type: block.type,
      };
    });
  };

  // Handle Historical Rounds Updates
  this.handleHistoricalRounds = function(rounds) {

    // Flatten Nested Round Array
    if (rounds.length >= 1) {
      rounds = rounds.reduce((a, b) => a.concat(b));
    }

    // Return Rounds Updates
    return rounds.map((round) => {
      return {
        timestamp: Date.now(),
        miner: round.miner,
        worker: round.worker,
        identifier: round.identifier,
        invalid: round.invalid,
        round: round.round,
        solo: round.solo,
        stale: round.stale,
        times: round.times,
        type: round.type,
        valid: round.valid,
        work: round.work,
      };
    });
  };

  // Combine Balances and Payments
  this.handleCombined = function(balances, payments) {

    // Iterate Through Payments
    const combined = Object.assign(balances, {});
    Object.keys(payments).forEach((identifier) => {
      if (identifier in combined) combined[identifier] += payments[identifier].generate;
      else combined[identifier] = payments[identifier];
    });

    // Return Combined Payments
    return combined;
  };

  // Handle Round Failure Updates
  this.handleFailures = function(blocks, callback) {

    // Build Combined Transaction
    const transaction = ['BEGIN;'];

    // Remove Finished Payments from Table
    const paymentsDelete = blocks.map((block) => `'${ block.round }'`);
    transaction.push(_this.current.payments.deletePoolPaymentsCurrent(
      _this.pool, paymentsDelete));

    // Insert Work into Database
    transaction.push('COMMIT;');
    _this.executor(transaction, () => callback());
  };

  // Handle Final Round Updates
  this.handleFinal = function(blocks, callback) {

    // Build Combined Transaction
    const transaction = ['BEGIN;'];

    // Remove Finished Transactions from Table
    const transactionsDelete = blocks.map((block) => `'${ block.round }'`);
    transaction.push(_this.current.transactions.deletePoolTransactionsCurrent(
      _this.pool, transactionsDelete));

    // Insert Work into Database
    transaction.push('COMMIT;');
    _this.executor(transaction, () => callback());
  };

  // Handle Round Reset Updates
  this.handleReset = function(blockType, callback) {

    // Build Combined Transaction
    const transaction = [
      'BEGIN;',
      _this.current.miners.insertPoolMinersReset(_this.pool, blockType),
      'COMMIT;'];

    // Insert Work into Database
    _this.executor(transaction, () => callback());
  };

  // Handle Round Success Updates
  this.handleUpdates = function(blocks, rounds, payments, blockType, callback) {

    // Build Combined Transaction
    const transaction = ['BEGIN;'];

    // Handle Historical Generate Block Updates
    const generateBlocksUpdates = _this.handleHistoricalBlocks(blocks);
    if (generateBlocksUpdates.length >= 1) {
      transaction.push(_this.historical.blocks.insertHistoricalBlocksCurrent(
        _this.pool, generateBlocksUpdates));
    }

    // Handle Historical Generate Round Updates
    const generateRoundsUpdates = _this.handleHistoricalRounds(rounds);
    if (generateRoundsUpdates.length >= 1) {
      transaction.push(_this.historical.rounds.insertHistoricalRoundsCurrent(
        _this.pool, generateRoundsUpdates));
    }

    // Handle Generate Block Delete Updates
    const generateBlocksDelete = blocks.map((block) => `'${ block.round }'`);
    if (generateBlocksDelete.length >= 1) {
      transaction.push(_this.current.blocks.deletePoolBlocksCurrent(
        _this.pool, generateBlocksDelete));
    }

    // Handle Generate Round Delete Updates
    const generateRoundsDelete = blocks.map((block) => `'${ block.round }'`);
    if (generateRoundsDelete.length >= 1) {
      transaction.push(_this.current.rounds.deletePoolRoundsCurrent(
        _this.pool, generateRoundsDelete));
    }

    // Insert Work into Database
    transaction.push('COMMIT;');
    _this.executor(transaction, () => callback());
  };

  // Handle Primary Updates
  this.handlePrimary = function(blocks, balances, callback) {

    // Build Combined Transaction
    const transaction = ['BEGIN;'];

    // Add Round Lookups to Transaction
    blocks.forEach((block) => {
      transaction.push(_this.current.rounds.selectPoolRoundsSpecific(
        _this.pool, block.solo, block.round, 'primary'));
    });

    // Determine Workers for Rounds
    transaction.push('COMMIT;');
    _this.executor(transaction, (results) => {
      const rounds = results.slice(1, -1).map((round) => round.rows);
      _this.stratum.stratum.handlePrimaryRounds(blocks, (error, updates) => {
        if (error) _this.handleFailures(updates, () => callback(error));
        else _this.stratum.stratum.handlePrimaryWorkers(blocks, rounds, (results) => {
          // const payments = _this.handleCombined(balances, results);
          _this.handleUpdates(updates, rounds, results, 'primary', () => callback(null));
        });
      });
    });
  };

  // Handle Auxiliary Updates
  this.handleAuxiliary = function(blocks, balances, callback) {

    // Build Combined Transaction
    const transaction = ['BEGIN;'];

    // Add Round Lookups to Transaction
    blocks.forEach((block) => {
      transaction.push(_this.current.rounds.selectPoolRoundsSpecific(
        _this.pool, block.solo, block.round, 'auxiliary'));
    });

    // Determine Workers for Rounds
    transaction.push('COMMIT;');
    _this.executor(transaction, (results) => {
      const rounds = results.slice(1, -1).map((round) => round.rows);
      _this.stratum.stratum.handleAuxiliaryRounds(blocks, (error, updates) => {
        if (error) _this.handleFailures(updates, () => callback(error));
        else _this.stratum.stratum.handleAuxiliaryWorkers(blocks, rounds, (results) => {
          // const payments = _this.handleCombined(balances, results);
          _this.handleUpdates(updates, rounds, results, 'primary', () => callback(null));
        });
      });
    });
  };

  // Handle Payment Updates
  this.handleRounds = function(lookups, blockType) {

    // Build Combined Transaction
    const transaction = ['BEGIN;'];

    // Build Checks for Each Block
    const checks = [];
    if (lookups[1].rows[0]) {
      lookups[1].rows.forEach((block) => {
        checks.push({ timestamp: Date.now(), round: block.round, type: blockType });
      });
    }

    // Build Existing Miner Balances
    const balances = {};
    if (lookups[2].rows[0]) {
      lookups[2].rows.forEach((miner) => {
        const identifier = `${ miner.miner }_${ miner.solo }_${ miner.type }`;
        if (identifier in balances) balances[identifier] += miner.balance;
        else balances[identifier] = miner.balance;
      });
    }

    // Add Checks to Payments Table
    if (checks.length >= 1) {
      transaction.push(_this.current.payments.insertPoolPaymentsCurrent(_this.pool, checks));
    }

    // Establish Separate Behavior
    transaction.push('COMMIT;');
    switch (blockType) {

    // Primary Behavior
    case 'primary':
      _this.executor(transaction, (results) => {
        results = results[1].rows.map((block) => block.round);
        const blocks = lookups[1].rows.filter((block) => results.includes((block || {}).round));

        // Blocks Exist to Send Payments
        if (blocks.length >= 1) {
          _this.handlePrimary(blocks, balances, (error) => {
            _this.handleFinal(blocks, () => {
              const updates = [(error) ?
                _this.text.databaseCommandsText2(JSON.stringify(error)) :
                _this.text.databaseUpdatesText4(blockType, blocks.length)];
              _this.logger.log('Payments', _this.config.name, updates);
            });
          });

        // No Blocks Exist to Send Payments
        } else {
          _this.handleReset(blockType, () => {
            const updates = [_this.text.databaseUpdatesText5(blockType)];
            _this.logger.log('Payments', _this.config.name, updates);
          });
        }
      });
      break;

    // Auxiliary Behavior
    case 'auxiliary':
      _this.executor(transaction, (results) => {
        results = results[1].rows.map((block) => block.round);
        const blocks = lookups[1].rows.filter((block) => results.includes((block || {}).round));

        // Blocks Exist to Send Payments
        if (blocks.length >= 1) {
          _this.handleAuxiliary(blocks, balances, (error) => {
            _this.handleFinal(blocks, () => {
              const updates = [(error) ?
                _this.text.databaseCommandsText2(JSON.stringify(error)) :
                _this.text.databaseUpdatesText4(blockType, blocks.length)];
              _this.logger.log('Payments', _this.config.name, updates);
            });
          });

        // No Blocks Exist to Send Payments
        } else {
          _this.handleReset(blockType, () => {
            const updates = [_this.text.databaseUpdatesText5(blockType)];
            _this.logger.log('Payments', _this.config.name, updates);
          });
        }
      });
      break;

    // Default Behavior
    default:
      break;
    }
  };

  // Handle Payments Updates
  this.handlePayments = function(blockType) {

    // Handle Initial Logging
    const balance = _this.config.primary.payments.minPayment;
    const starting = [_this.text.databaseStartingText3(blockType)];
    _this.logger.log('Payments', _this.config.name, starting);

    // Build Combined Transaction
    const transaction = [
      'BEGIN;',
      _this.current.blocks.selectPoolBlocksCategory(_this.pool, 'generate', blockType),
      _this.current.miners.selectPoolMinersBalance(_this.pool, balance, blockType),
      'COMMIT;'];

    // Establish Separate Behavior
    _this.executor(transaction, (lookups) => {
      _this.handleRounds(lookups, blockType);
    });
  };

  // Start Payments Interval Management
  /* istanbul ignore next */
  this.handleInterval = function() {
    const minInterval = _this.config.settings.paymentsInterval * 0.75;
    const maxInterval = _this.config.settings.paymentsInterval * 1.25;
    const random = Math.floor(Math.random() * (maxInterval - minInterval) + minInterval);
    setTimeout(() => {
      _this.handlePayments('primary');
      if (_this.config.auxiliary && _this.config.auxiliary.enabled) {
        _this.handlePayments('auxiliary');
      }
    }, random);
  };

  // Start Payments Capabilities
  /* istanbul ignore next */
  this.setupPayments = function(stratum, callback) {
    _this.stratum = stratum;
    _this.handleInterval();
    callback();
  };
};

module.exports = Payments;
