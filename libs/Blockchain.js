const SHA256 = require('crypto-js/sha256');
const { VM, VMScript } = require('vm2');
const currency = require('currency.js');
const Loki = require('lokijs');
const { Base64 } = require('js-base64');
const fs = require('fs-extra');
const lfsa = require('./loki-fs-structured-adapter.js');


const { DBUtils } = require('./DBUtils');

class Transaction {
  constructor(refSteemBlockNumber, transactionId, sender, contract, action, payload) {
    this.refSteemBlockNumber = refSteemBlockNumber;
    this.transactionId = transactionId;
    this.sender = sender;
    this.contract = typeof contract === 'string' ? contract : null;
    this.action = typeof action === 'string' ? action : null;
    this.payload = typeof payload === 'string' ? payload : null;
    this.hash = this.calculateHash();
    this.logs = {};
  }

  // add logs to the transaction
  // useful to get the result of the execution of a smart contract (events and errors)
  addLogs(logs) {
    const finalLogs = logs;
    if (finalLogs && finalLogs.errors && finalLogs.errors.length === 0) {
      delete finalLogs.errors;
    }

    if (finalLogs && finalLogs.events && finalLogs.events.length === 0) {
      delete finalLogs.events;
    }

    this.logs = JSON.stringify(finalLogs);
  }

  // calculate the hash of the transaction
  calculateHash() {
    return SHA256(
      this.refSteemBlockNumber
      + this.transactionId
      + this.sender
      + this.contract
      + this.action
      + this.payload,
    )
      .toString();
  }
}

class Block {
  constructor(timestamp, transactions, previousBlockNumber, previousHash = '') {
    this.blockNumber = previousBlockNumber + 1;
    this.refSteemBlockNumber = transactions.length > 0 ? transactions[0].refSteemBlockNumber : 0;
    this.previousHash = previousHash;
    this.timestamp = timestamp;
    this.transactions = transactions;
    this.hash = this.calculateHash();
    this.merkleRoot = '';
  }

  // calculate the hash of the block
  calculateHash() {
    return SHA256(this.previousHash + this.timestamp + JSON.stringify(this.transactions))
      .toString();
  }

  // calculate the Merkle root of the block ((#TA + #TB) + (#TC + #TD) )
  calculateMerkleRoot(transactions) {
    if (transactions.length <= 0) return '';

    const tmpTransactions = transactions.slice(0, transactions.length);
    const newTransactions = [];
    const nbTransactions = tmpTransactions.length;

    for (let index = 0; index < nbTransactions; index += 2) {
      const left = tmpTransactions[index].hash;
      const right = index + 1 < nbTransactions ? tmpTransactions[index + 1].hash : left;

      newTransactions.push({ hash: SHA256(left + right).toString() });
    }

    if (newTransactions.length === 1) {
      return newTransactions[0].hash;
    }

    return this.calculateMerkleRoot(newTransactions);
  }

  // produce the block (deploy a smart contract or execute a smart contract)
  produceBlock(state, jsVMTimeout) {
    this.transactions.forEach((transaction) => {
      const {
        sender,
        contract,
        action,
        payload,
      } = transaction;

      let logs = null;

      if (sender && contract && action) {
        if (contract === 'contract' && action === 'deploy' && payload) {
          logs = Block.deploySmartContract(state, transaction, jsVMTimeout);
        } else {
          logs = Block.executeSmartContract(state, transaction, jsVMTimeout);
        }
      } else {
        logs = { errors: ['the parameters sender, contract and action are required'] };
      }

      transaction.addLogs(logs);
    });

    this.hash = this.calculateHash();
    this.merkleRoot = this.calculateMerkleRoot(this.transactions);
  }

  // deploy the smart contract to the blockchain and initialize the database if needed
  static deploySmartContract(state, transaction, jsVMTimeout) {
    try {
      const { refSteemBlockNumber, sender } = transaction;
      const payload = JSON.parse(transaction.payload);
      const { name, params, code } = payload;

      if (name && typeof name === 'string'
        && code && typeof code === 'string') {
        // the contract name has to be a string made of letters and numbers
        const RegexLettersNumbers = /^[a-zA-Z0-9_]+$/;
        const RegexLetters = /^[a-zA-Z_]+$/;

        if (!RegexLettersNumbers.test(name)) {
          return { errors: ['invalid contract name'] };
        }

        const contracts = state.database.getCollection('contracts');
        const contract = contracts.findOne({ name });

        // for now the contracts are immutable
        if (contract) {
          // contract.code = code;
          return { errors: ['contract already exists'] };
        }

        // this code template is used to manage the code of the smart contract
        // this way we keep control of what can be executed in a smart contract
        let codeTemplate = `
          let actions = {};

          ###ACTIONS###

          if (action && typeof action === 'string' && typeof actions[action] === 'function') {
            if (action !== 'createSSC') {
              actions.createSSC = null;
            }

            actions[action](payload);
          }
        `;

        // the code of the smart contarct comes as a Base64 encoded string
        codeTemplate = codeTemplate.replace('###ACTIONS###', Base64.decode(code));

        // compile the code for faster executions later on
        const script = new VMScript(codeTemplate).compile();

        const tables = [];

        // prepare the db object that will be available in the VM
        const db = {
          // createTable is only available during the smart contract deployment
          createTable: (tableName) => {
            if (!RegexLetters.test(tableName)) return null;
            const finalTableName = `${name}_${tableName}`;
            const table = state.database.getCollection(finalTableName);
            if (table) return table;

            tables.push(finalTableName);
            return state.database.addCollection(finalTableName);
          },
          // perform a query on the tables of other smart contracts
          findInTable: (contractName, table, query) => DBUtils.findInTable(
            state,
            contractName,
            table,
            query,
          ),
          // perform a query on the tables of other smart contracts
          findOneInTable: (contractName, table, query) => DBUtils.findOneInTable(
            state,
            contractName,
            table,
            query,
          ),
        };

        // logs used to store events or errors
        const logs = {
          errors: [],
          events: [],
        };

        // initialize the state that will be available in the VM
        const vmState = {
          action: 'createSSC',
          payload: params ? JSON.parse(JSON.stringify(params)) : null,
          refSteemBlockNumber,
          db,
          currency,
          debug: log => console.log(log), // eslint-disable-line no-console
          // execute a smart contract from the current smart contract
          executeSmartContract: (contractName, actionName, parameters) => {
            if (typeof contractName !== 'string' || typeof actionName !== 'string' || (parameters && typeof parameters !== 'string')) return null;
            const sanitizedParams = parameters ? JSON.parse(parameters) : null;

            // check if a recipient or amountSTEEMSBD
            //  or isSignedWithActiveKey  were passed initially
            if (params && params.amountSTEEMSBD) {
              sanitizedParams.amountSTEEMSBD = params.amountSTEEMSBD;
            }

            if (params && params.recipient) {
              sanitizedParams.recipient = params.recipient;
            }

            if (params && params.isSignedWithActiveKey) {
              sanitizedParams.isSignedWithActiveKey = params.isSignedWithActiveKey;
            }

            const res = Block.executeSmartContract(
              state,
              {
                sender,
                contract: contractName,
                action: actionName,
                payload: JSON.stringify(sanitizedParams),
              },
              jsVMTimeout,
            );
            res.errors.forEach(error => logs.errors.push(error));
            res.events.forEach(event => logs.events.push(event));

            const results = {};
            res.errors.forEach((error) => {
              if (results.errors === undefined) {
                results.errors = [];
              }
              logs.errors.push(error);
              results.errors.push(error);
            });
            res.events.forEach((event) => {
              if (results.events === undefined) {
                results.events = [];
              }
              logs.events.push(event);
              results.events.push(event);
            });

            return results;
          },
          // emit an event that will be stored in the logs
          emit: (event, data) => typeof event === 'string' && logs.events.push({ event, data }),
          // add an error that will be stored in the logs
          assert: (condition, error) => {
            if (!condition && typeof error === 'string') {
              logs.errors.push(error);
            }
            return condition;
          },
        };

        Block.runContractCode(vmState, script, jsVMTimeout);

        const newContract = {
          name,
          owner: sender,
          code: codeTemplate,
          tables,
        };

        contracts.insert(newContract);

        return logs;
      }

      return { errors: ['parameters name and code are mandatory and they must be strings'] };
    } catch (e) {
      // console.error('ERROR DURING CONTRACT DEPLOYMENT: ', e);
      return { errors: [`${e.name}: ${e.message}`] };
    }
  }

  // execute the smart contract and perform actions on the database if needed
  static executeSmartContract(state, transaction, jsVMTimeout) {
    try {
      const {
        sender,
        contract,
        action,
        payload,
        refSteemBlockNumber,
      } = transaction;

      if (action === 'createSSC') return { errors: ['you cannot trigger the createSSC action'] };

      const payloadObj = payload ? JSON.parse(payload) : {};

      const contracts = state.database.getCollection('contracts');
      const contractInDb = contracts.findOne({ name: contract });
      if (contractInDb === null) {
        return { errors: ['contract doesn\'t exist'] };
      }

      const contractCode = contractInDb.code;
      const contractOwner = contractInDb.owner;

      // prepare the db object that will be available in the VM
      const db = {
        // get a table that is owned by the current smart contract
        getTable: (tableName) => {
          const finalTableName = `${contract}_${tableName}`;
          if (contractInDb.tables.includes(finalTableName)) {
            return state.database.getCollection(finalTableName);
          }

          return null;
        },
        // perform a query on the tables of other smart contracts
        findInTable: (contractName, table, query) => DBUtils.findInTable(
          state,
          contractName,
          table,
          query,
        ),
        // perform a query on the tables of other smart contracts
        findOneInTable: (contractName, table, query) => DBUtils.findOneInTable(
          state,
          contractName,
          table,
          query,
        ),
      };

      // logs used to store events or errors
      const logs = {
        errors: [],
        events: [],
      };

      // initialize the state that will be available in the VM
      const vmState = {
        sender,
        owner: contractOwner,
        refSteemBlockNumber,
        action,
        payload: JSON.parse(JSON.stringify(payloadObj)),
        db,
        currency,
        debug: log => console.log(log), // eslint-disable-line no-console
        // execute a smart contract from the current smart contract
        executeSmartContract: (contractName, actionName, params) => {
          if (typeof contractName !== 'string' || typeof actionName !== 'string' || (params && typeof params !== 'string')) return null;
          const sanitizedParams = params ? JSON.parse(params) : null;

          // check if a recipient or amountSTEEMSBD or isSignedWithActiveKey  were passed initially
          if (payloadObj && payloadObj.amountSTEEMSBD) {
            sanitizedParams.amountSTEEMSBD = payloadObj.amountSTEEMSBD;
          }

          if (payloadObj && payloadObj.recipient) {
            sanitizedParams.recipient = payloadObj.recipient;
          }

          if (payloadObj && payloadObj.isSignedWithActiveKey) {
            sanitizedParams.isSignedWithActiveKey = payloadObj.isSignedWithActiveKey;
          }

          const res = Block.executeSmartContract(
            state,
            {
              sender,
              contract: contractName,
              action: actionName,
              payload: JSON.stringify(sanitizedParams),
            },
            jsVMTimeout,
          );
          const results = {};
          res.errors.forEach((error) => {
            if (results.errors === undefined) {
              results.errors = [];
            }
            logs.errors.push(error);
            results.errors.push(error);
          });
          res.events.forEach((event) => {
            if (results.events === undefined) {
              results.events = [];
            }
            logs.events.push(event);
            results.events.push(event);
          });

          return results;
        },
        // emit an event that will be stored in the logs
        emit: (event, data) => typeof event === 'string' && logs.events.push({ event, data }),
        // add an error that will be stored in the logs
        assert: (condition, error) => {
          if (!condition && typeof error === 'string') {
            logs.errors.push(error);
          }
          return condition;
        },
      };

      Block.runContractCode(vmState, contractCode, jsVMTimeout);

      return logs;
    } catch (e) {
      // console.error('ERROR DURING CONTRACT EXECUTION: ', e);
      return { errors: [`${e.name}: ${e.message}`] };
    }
  }

  // run the contractCode in a VM with the vmState as a state for the VM
  static runContractCode(vmState, contractCode, jsVMTimeout) {
    // run the code in the VM
    const vm = new VM({
      timeout: jsVMTimeout,
      sandbox: vmState,
    });

    vm.run(contractCode);
  }
}

class Blockchain {
  constructor(chainId, autosaveInterval, jsVMTimeout) {
    this.chain = null;
    this.chainId = chainId;
    this.pendingTransactions = [];
    this.state = {};

    this.blockchainFilePath = '';
    this.databaseFilePath = '';
    this.autosaveInterval = autosaveInterval;
    this.jsVMTimeout = jsVMTimeout;

    this.producing = false;
    this.saving = false;
    this.loading = false;
  }

  // create the genesis block of the blockchain
  static createGenesisBlock(chainId) {
    const genesisBlock = new Block('2018-06-01T00:00:00', [{ chainId }], -1, '0');
    return genesisBlock;
  }

  // load the database from the filesystem
  loadBlockchain(dataDirectory, databaseFile, callback) {
    this.loading = true;

    this.databaseFilePath = dataDirectory + databaseFile;

    // check if the app has already be run
    if (fs.pathExistsSync(this.databaseFilePath)) {
      // load the blockchain
      this.lokiJSAdapter = new lfsa(); // eslint-disable-line new-cap
      this.state = {
        database: new Loki(this.databaseFilePath, {
          adapter: this.lokiJSAdapter,
          autosave: this.autosaveInterval > 0,
          autosaveInterval: this.autosaveInterval,
        }),
      };

      // load the database from the filesystem to the RAM
      this.state.database.loadDatabase({}, (errorDb) => {
        if (errorDb) {
          callback(errorDb);
        }

        // if the chain or the contracts collection doesn't exist we return an error
        this.chain = this.state.database.getCollection('chain');
        if (this.chain === null
          || this.state.database.getCollection('contracts') === null) {
          callback('The database is missing either the chain or the contracts table');
        }

        this.loading = false;
        callback(null);
      });
    } else {
      // create the data directory if necessary and empty it if files exists
      fs.emptyDirSync(dataDirectory);

      // init the database
      this.lokiJSAdapter = new lfsa(); // eslint-disable-line new-cap
      this.state = {
        database: new Loki(this.databaseFilePath, {
          adapter: this.lokiJSAdapter,
          autosave: this.autosaveInterval > 0,
          autosaveInterval: this.autosaveInterval,
        }),
      };

      // init the main tables
      this.chain = this.state.database.addCollection('chain');
      this.state.database.addCollection('contracts');

      // insert the genesis block
      this.chain.insert(Blockchain.createGenesisBlock(this.chainId));

      this.loading = false;
      callback(null);
    }
  }

  // save the blockchain as well as the database on the filesystem
  saveBlockchain(callback) {
    // if a block is being produced we wait until it is completed
    if (this.producing) this.saveBlockchain(callback);
    this.saving = !this.producing;

    // save the database from the RAM to the filesystem
    this.state.database.saveDatabase((err) => {
      if (err) {
        callback(err);
      }

      callback(null);
    });
  }

  // get the latest block of the blockchain
  getLatestBlock() {
    const { maxId } = this.chain;
    return this.chain.findOne({ $loki: maxId });
  }

  // produce all the pending transactions, that will result in the creattion of a block
  producePendingTransactions(timestamp) {
    // the block producing is aborted if the blockchain is being saved
    if (this.saving) return;

    // if the blockchain is loadng we postpone the production
    if (this.loading) this.producePendingTransactions(timestamp);

    this.producing = true;
    const previousBlock = this.getLatestBlock();
    const block = new Block(
      timestamp,
      this.pendingTransactions,
      previousBlock.blockNumber,
      previousBlock.hash,
    );
    block.produceBlock(this.state, this.jsVMTimeout);

    this.chain.insert(block);

    this.pendingTransactions = [];
    this.producing = false;
  }

  // create a transaction that will be then included in a block
  createTransaction(transaction) {
    this.pendingTransactions.push(transaction);
  }

  // check if the blockchain is valid by checking the block hashes and Merkle roots
  isChainValid() {
    const chain = this.chain.find();

    for (let i = 1; i < chain.length; i += 1) {
      const currentBlock = chain[i];
      const previousBlock = chain[i - 1];

      if (currentBlock.merkleRoot !== currentBlock.calculateMerkleRoot(currentBlock.transactions)) {
        return false;
      }

      if (currentBlock.hash !== currentBlock.calculateHash()) {
        return false;
      }

      if (currentBlock.previousHash !== previousBlock.hash) {
        return false;
      }
    }

    return true;
  }

  // replay the entire blockchain (rebuild the database as well)
  replayBlockchain(dataDirectory) {
    const chain = this.chain.find();

    // create the data directory if necessary and empty it if files exists
    fs.emptyDirSync(dataDirectory);

    // init the database
    this.lokiJSAdapter = new lfsa(); // eslint-disable-line new-cap
    this.state = {
      database: new Loki(this.databaseFilePath, {
        adapter: this.lokiJSAdapter,
        autosave: this.autosaveInterval > 0,
        autosaveInterval: this.autosaveInterval,
      }),
    };

    // init the main tables
    this.chain = this.state.database.addCollection('chain');
    this.state.database.addCollection('contracts');

    // insert the genesis block
    this.chain.insert(Blockchain.createGenesisBlock(this.chainId));

    for (let i = 0; i < chain.length; i += 1) {
      const txLength = chain[i].transactions.length;
      const txs = chain[i].transactions;

      for (let j = 0; j < txLength; j += 1) {
        const {
          refSteemBlockNumber,
          transactionId,
          sender,
          contract,
          action,
          payload,
        } = txs[j];
        this.createTransaction(
          new Transaction(refSteemBlockNumber, transactionId, sender, contract, action, payload),
        );
      }

      this.producePendingTransactions(chain[i].timestamp);
    }
  }

  // RPC methods

  // get the block that has the block number blockNumber
  getBlockInfo(blockNumber) {
    if (blockNumber && typeof blockNumber === 'number') {
      // the $loki field starts from 1 so the block 0 has the id 1
      // so to get the actual block we need to add 1 to blockNumber
      return this.chain.findOne({ $loki: blockNumber + 1 });
    }

    return null;
  }

  // get the latest block available on the blockchain
  getLatestBlockInfo() {
    return this.getLatestBlock();
  }

  // find records in the contract table by using the query, returns empty array if no records found
  findInTable(contract, table, query) {
    return DBUtils.findInTable(this.state, contract, table, query);
  }

  // find one record in the table of a contract by using the query, returns nullrecord found
  findOneInTable(contract, table, query) {
    return DBUtils.findOneInTable(this.state, contract, table, query);
  }

  // get the contract info (owner, code, tables available, etc...)
  getContract(contract) {
    return DBUtils.getContract(this.state, contract);
  }
}

module.exports.Transaction = Transaction;
module.exports.Blockchain = Blockchain;
