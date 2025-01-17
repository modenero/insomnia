import { config } from './config'
import fs from 'fs'
import { ElectrumCluster, ElectrumClient } from 'electrum-cash'
import BigNumber from 'bignumber.js'
import express from 'express'
import bodyParser from 'body-parser'
import bitcore from 'bitcore-lib-cash'
import {
    GenesisParseResult,
    MintParseResult,
    SendParseResult,
    parseSLP,
} from 'slp-parser'
import { toCashAddress, toSlpAddress } from 'bchaddrjs-slp'
import morgan from 'morgan'
import rateLimit from 'express-rate-limit'
import path from 'path'

let electrum = null

if (config.electrum.connectionType === 'cluster') {
    electrum = new ElectrumCluster(
        config.electrum.application,
        config.electrum.version,
        config.electrum.confidence,
        config.electrum.distribution,
    )

    for (const server of config.electrum.servers) {
        const [host, port] = server.split(':')

        if (typeof(host) === 'undefined' || typeof(port) === 'undefined') {
            throw new Error('server field has bad format (should be host:port)')
        }

        electrum.addServer(host, port)
    }
} else if (config.electrum.connectionType === 'client') {
    const [hostname, port] = config.electrum.servers[0].split(':')

    electrum = new ElectrumClient(
        config.electrum.application,
        config.electrum.version,
        hostname,
        parseInt(port, 10)
    )
} else {
  console.log('unknown electrum.connectionType')
  process.exit(1)
}

const apiLimiter = rateLimit({
    ...config.ratelimit,
    ...{
        message: {
            success: false,
            message: 'Too many requests'
        }
    }
})

const app = express()
app.use(bodyParser.text({ limit: '250kb' }))
app.disable('x-powered-by')
app.use('/v1/', apiLimiter)

app.use(express.static(path.join(__dirname, '..', 'public')))

app.use(morgan('dev', {
    // skip: (req, res) => res.statusCode < 400
}))

const router = express.Router()
app.use('/v1', router)

async function blockchainTransactionGet(transactionID: string) {
    const electrumResponse = await electrum
        .request('blockchain.transaction.get', transactionID, false)

    if (electrumResponse instanceof Error) {
        throw electrumResponse
    }

    if (electrumResponse.hasOwnProperty('code')) {
        throw new Error(electrumResponse.message)
    }

    return electrumResponse
}

function hydrateTransaction(transactionHex: string): any {
    const tx = new bitcore.Transaction(transactionHex)

    let response = tx.toJSON()

    for (let input of response.inputs) {
        try {
            const script = new bitcore.Script(input.script)
            input.cashAddress = script.toAddress().toString()
            input.slpAddress = toSlpAddress(input.cashAddress)
        } catch (e) {
            input.cashAddress = null
            input.slpAddress = null
        }
    }

    for (let output of response.outputs) {
        try {
            const script = new bitcore.Script(output.script)
            output.cashAddress = script.toAddress().toString()
            output.slpAddress = toSlpAddress(output.cashAddress)
        } catch (e) {
            output.cashAddress = null
            output.slpAddress = null
        }
    }

    if (response.outputs.length > 0) {
        try {
            const parsed = parseSLP(response.outputs[0].script);
            const fmtd: any = parsed;

            if (parsed.transactionType === "GENESIS") {
                let o = parsed.data as GenesisParseResult;
                fmtd.data.ticker       = o.ticker.toString('hex');
                fmtd.data.name         = o.ticker.toString('hex');
                fmtd.data.documentUri  = o.documentUri.toString('hex');
                fmtd.data.documentHash = o.documentHash.toString('hex');
            } else if (parsed.transactionType === "MINT") {
                let o = parsed.data as MintParseResult;
                fmtd.data.tokenId = o.tokenId.toString('hex');
            } else if (parsed.transactionType === "SEND") {
                let o = parsed.data as SendParseResult;
                fmtd.data.tokenId  = o.tokenId.toString('hex');
            }

            response.slp = parsed;
        } catch (e) {
            response.slp = {
                error: e.message
            }
        }
    }

    return response
}

router.get('/tx/data/:txid', async (req, res) => {
  const transactionID = req.params.txid;
  const verbose = req.query.verbose === 'true';
  try {
    var electrumResponse = await blockchainTransactionGet(transactionID);
  } catch (e) {
    return res.status(400).send({
      success: false,
      message: electrumResponse.message,
    });
  }

  let response = null;
  if (! verbose) {
    response = electrumResponse;
  } else {
    try {
      response = hydrateTransaction(electrumResponse);
    }catch (e) {
      return res.status(500).send({
        success: false,
        message: e.message,
      });
    }
  }

  return res.send({
    success: true,
    tx:      response,
  });
});

router.get('/tx/merkle/:txid/:height', async (req, res) => {
  try {
    if (isNaN(req.params.height as any)) {
      throw new Error('invalid parameter height; expected integer');
    }
  } catch (e) {
    return res.status(400).send({
      success: false,
      message: e.message,
    });
  }
  const transactionID = req.params.txid;
  const blockHeight = parseInt(req.params.height, 10);
  try {
    var electrumResponse = await electrum.request('blockchain.transaction.get_merkle', transactionID, blockHeight);
  } catch (e) {
    return res.status(500).send({
      success: false,
      message: e.message,
    });
  }

  if (electrumResponse.hasOwnProperty("code")) {
    return res.status(400).send({
      success: false,
      message: electrumResponse.message,
    });
  }

  return res.send({
    success: true,
    merkle: electrumResponse.merkle,
  });
});

router.post('/tx/broadcast', async (req, res) => {
  const transactionHex = req.body;
  try {
    var electrumResponse = await electrum.request('blockchain.transaction.broadcast', transactionHex);
  } catch (e) {
    return res.status(500).send({
      success: false,
      message: e.message,
    });
  }

  if (electrumResponse.hasOwnProperty("code")) {
    return res.status(400).send({
      success: false,
      message: electrumResponse.message,
    });
  }

  if (! electrumResponse.toString().match(/^[a-f0-9]{64}$/)) {
    return res.status(400).send({
      success: false,
      message: electrumResponse.toString(),
    });
  }

  return res.send({
    success: true,
    txid: electrumResponse,
  });
});

router.get('/block/headers/:height', async (req, res) => {
  try {
    if (isNaN(req.params.height as any)) {
      throw new Error('invalid parameter height; expected integer');
    }
    if (req.query.count && isNaN(req.query.count as any)) {
      throw new Error('invalid parameter count; expected integer');
    }
    if (req.query.cp_height && isNaN(req.query.cp_height as any)) {
      throw new Error('invalid parameter cp_height; expected integer');
    }
  } catch (e) {
    return res.status(400).send({
      success: false,
      message: e.message,
    });
  }
  const blockHeight = parseInt(req.params.height, 10);
  const count = parseInt(req.query.count as string, 10) || 1;
  const cpHeight = parseInt(req.query.cp_height as string, 10) || 0;
  try {
    var electrumResponse = await electrum.request('blockchain.block.headers', blockHeight, count, cpHeight);
  } catch (e) {
    return res.status(500).send({
      success: false,
      message: e.message,
    });
  }

  if (electrumResponse.hasOwnProperty("code")) {
    return res.status(400).send({
      success: false,
      message: electrumResponse.message,
    });
  }

  try {
    if (electrumResponse instanceof Error) {
      throw electrumResponse;
    }
  } catch (e) {
    return res.status(400).send({
      success: false,
      message: electrumResponse.message,
    });
  }

  return res.send({
    success: true,
    headers: electrumResponse.hex.match(/.{160}/g),
  });
});


const addressToScripthash = (addrstr: string) => {
  addrstr = toCashAddress(addrstr); // allow conversion of different address types
  const address = bitcore.Address.fromString(addrstr)
  const script = bitcore.Script.fromAddress(address);
  const scripthash = bitcore.crypto.Hash.sha256(script.toBuffer()).reverse().toString('hex');

  return scripthash;
}

router.get('/address/balance/:address', async (req, res) => {
  try {
    var scripthash = addressToScripthash(req.params.address);
  } catch (e) {
    return res.status(400).send({
      success: false,
      message: 'could not decode address',
    });
  }

  try {
    var electrumResponse = await electrum.request('blockchain.scripthash.get_balance', scripthash);
  } catch (e) {
    return res.status(500).send({
      success: false,
      message: e.message,
    });
  }

  if (electrumResponse.hasOwnProperty("code")) {
    return res.status(400).send({
      success: false,
      message: electrumResponse.message,
    });
  }

  return res.send({
    success: true,
    confirmed: electrumResponse.confirmed,
    unconfirmed: electrumResponse.unconfirmed,
  });
});

router.get('/address/history/:address', async (req, res) => {
  try {
    var scripthash = addressToScripthash(req.params.address);
  } catch (e) {
    return res.status(400).send({
      success: false,
      message: 'could not decode address',
    });
  }

  try {
    var electrumResponse = await electrum.request('blockchain.scripthash.get_history', scripthash);
  } catch (e) {
    return res.status(500).send({
      success: false,
      message: e.message,
    });
  }

  if (electrumResponse.hasOwnProperty("code")) {
    return res.status(400).send({
      success: false,
      message: electrumResponse.message,
    });
  }

  return res.send({
    success: true,
    txs: electrumResponse,
  });
});

router.get('/address/mempool/:address', async (req, res) => {
  try {
    var scripthash = addressToScripthash(req.params.address);
  } catch (e) {
    return res.status(400).send({
      success: false,
      message: 'could not decode address',
    });
  }

  try {
    var electrumResponse = await electrum.request('blockchain.scripthash.get_mempool', scripthash);
  } catch (e) {
    return res.status(500).send({
      success: false,
      message: e.message,
    });
  }

  if (electrumResponse.hasOwnProperty("code")) {
    return res.status(400).send({
      success: false,
      message: electrumResponse.message,
    });
  }

  return res.send({
    success: true,
    txs: electrumResponse,
  });
});

router.get('/address/utxos/:address', async (req, res) => {
  try {
    var scripthash = addressToScripthash(req.params.address);
  } catch (e) {
    return res.status(400).send({
      success: false,
      message: 'could not decode address',
    });
  }

  try {
    var electrumResponse = await electrum.request('blockchain.scripthash.listunspent', scripthash);
  } catch (e) {
    return res.status(500).send({
      success: false,
      message: e.message,
    });
  }

  if (electrumResponse.hasOwnProperty("code")) {
    return res.status(400).send({
      success: false,
      message: electrumResponse.message,
    });
  }

  return res.send({
    success: true,
    utxos: electrumResponse,
  });
});

router.get('/dsproof/data/:txid', async (req, res) => {
  const transactionID = req.params.txid;
  try {
    var electrumResponse = await electrum.request('blockchain.transaction.dsproof.get', transactionID);

    if (electrumResponse !== null) {
      if (electrumResponse instanceof Error) {
        throw electrumResponse;
      }

      if (electrumResponse.hasOwnProperty("code")) {
        throw new Error(electrumResponse.message);
      }
    }
  } catch (e) {
    return res.status(400).send({
      success: false,
      message: e.message,
    });
  }

  return res.send({
    success: true,
    proof:   electrumResponse,
  });
});

router.get('/dsproof/list', async (req, res) => {
  try {
    var electrumResponse = await electrum.request('blockchain.transaction.dsproof.list');

    if (electrumResponse instanceof Error) {
      throw electrumResponse;
    }

    if (electrumResponse.hasOwnProperty("code")) {
      throw new Error(electrumResponse.message);
    }
  } catch (e) {
    return res.status(500).send({
      success: false,
      message: e.message,
    });
  }

  return res.send({
    success: true,
    txs:     electrumResponse,
  });
});


(async () => {
    if (config.electrum.connectionType === 'cluster') {
        await electrum.ready()
    } else if (config.electrum.connectionType === 'client') {
        await electrum.connect()
    }

    app.listen(config.port)
    console.log(`\n  Now listening on port [ ${config.port} ]\n`)

    process.on('beforeExit', async () => {
        if (config.electrum.connectionType === 'cluster') {
            await electrum.shutdown()
        } else if (config.electrum.connectionType === 'client') {
            await electrum.disconnect()
        }

        process.exit(0)
    })
})()
