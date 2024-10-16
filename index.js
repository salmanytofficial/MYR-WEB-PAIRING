const express = require('express');
const fs = require('fs');
const pino = require('pino');
const NodeCache = require('node-cache');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    Browsers,
    makeCacheableSignalKeyStore,
    DisconnectReason
} = require('@whiskeysockets/baileys');
const { upload } = require('./mega'); // Ensure you have a mega.js for the upload function
const { Mutex } = require('async-mutex');
const config = require('./config'); // Ensure you have a config.js file

const app = express();
const port = 3000;
let session;
const msgRetryCounterCache = new NodeCache();
const mutex = new Mutex();

// Serve static files from the public directory
app.use(express.static('public'));

// Serve index.html directly at the root URL
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html'); // Serve index.html directly
});

async function connector(Num, res) {
    const sessionDir = './session';
    if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir);
    }
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    session = makeWASocket({
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }).child({ level: 'fatal' }))
        },
        printQRInTerminal: false,
        logger: pino({ level: 'fatal' }).child({ level: 'fatal' }),
        browser: Browsers.macOS("Safari"),
        markOnlineOnConnect: true,
        msgRetryCounterCache
    });

    if (!session.authState.creds.registered) {
        await delay(1500);
        Num = Num.replace(/[^0-9]/g, ''); // Clean the number
        const code = await session.requestPairingCode(Num);
        if (!res.headersSent) {
            res.send({ code: code?.match(/.{1,4}/g)?.join('-') });
        }
    }

    session.ev.on('creds.update', async () => {
        await saveCreds();
    });

    session.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'open') {
            console.log('Connected successfully');
            await delay(5000);
            const myr = await session.sendMessage(session.user.id, { text: "Thank you for using our bot. Don't share your session ID." });
            const pth = './session/creds.json';
            try {
                const url = await upload(pth);
                let sID;
                if (url.includes("https://mega.nz/file/")) {
                    sID = config.PREFIX + url.split("https://mega.nz/file/")[1];
                } else {
                    sID = 'Error occurred';
                }
                await session.sendMessage(session.user.id, { 
                    image: { url: "https://cdn.ironman.my.id/i/2iceb4.jpeg" }, 
                    caption: `*Session ID*\n\n${sID}` 
                }, { quoted: myr });
            } catch (error) {
                console.error('Error:', error);
            } finally {
                await delay(1000);
                fs.rmdirSync(sessionDir, { recursive: true });
            }
        } else if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            reconn(reason);
        }
    });
}

function reconn(reason) {
    if ([DisconnectReason.connectionLost, DisconnectReason.connectionClosed, DisconnectReason.restartRequired].includes(reason)) {
        console.log('Connection lost, reconnecting...');
        connector(); // Attempt to reconnect
    } else {
        console.log(`Disconnected! Reason: ${reason}`);
        session.end(); // End session if disconnected for another reason
    }
}

app.get('/pair', async (req, res) => {
    const Num = req.query.code;
    if (!Num) {
        return res.status(400).json({ message: 'Phone number is required' });
    }

    const release = await mutex.acquire();
    try {
        await connector(Num, res);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "An error occurred while processing the request." });
    } finally {
        release();
    }
});

// Start the server
app.listen(port, () => {
    console.log(`Running on PORT: ${port}`);
});
