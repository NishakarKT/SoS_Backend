const http = require('http');

const players = new Map();
const games = new Map();
const queue = [];

const generateId = () => Math.random().toString(36).substr(2, 9);
const ts = () => `[${new Date().toLocaleTimeString()}]`;

const sendJSON = (res, data) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(data));
};

const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
        res.end(); return;
    }

    const url = req.url;
    let body = '';
    
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
        let data = {};
        try { data = body ? JSON.parse(body) : {}; } catch (e) { }

        // --- 1. JOIN ---
        if (url === '/join' && req.method === 'POST') {
            const pid = generateId();
            const teamStr = data.team || "";
            console.log(`${ts()} JOIN: ${data.name} (${pid})`);
            players.set(pid, { id: pid, name: data.name || "Trainer", team: teamStr, gameId: null, lastSeen: Date.now() });
            
            if (queue.length > 0) {
                let opponentId = queue[0];
                while (opponentId) {
                    const op = players.get(opponentId);
                    if (!op || (Date.now() - op.lastSeen > 5000)) {
                        players.delete(opponentId); queue.shift(); opponentId = queue[0];
                    } else { break; }
                }

                if (opponentId) {
                    queue.shift(); 
                    console.log(`${ts()} MATCH: ${pid} vs ${opponentId}`);
                    const gameId = generateId();
                    const seed = Math.floor(Math.random() * 100000); 

                    games.set(gameId, {
                        id: gameId, p1: opponentId, p2: pid,
                        turn: 1, // Server Authority on Turn Number
                        p1Action: null, p2Action: null,
                        p1Confirmed: false, p2Confirmed: false,
                        seed: seed,
                        latestChat: { sender: null, msg: "", timestamp: 0 }
                    });

                    players.get(opponentId).gameId = gameId;
                    players.get(pid).gameId = gameId;

                    return sendJSON(res, { status: 'matched', id: pid, gameId: gameId, seed: seed, role: 'p2', opponentTeam: players.get(opponentId).team });
                }
            }
            queue.push(pid);
            return sendJSON(res, { status: 'waiting', id: pid });
        }

        // --- 2. POLL ---
        if (url === '/poll' && req.method === 'POST') {
            const pid = data.id;
            const player = players.get(pid);
            if (!player) return sendJSON(res, { error: 'rejoin' }); 
            player.lastSeen = Date.now(); 

            if (!player.gameId) return sendJSON(res, { status: 'waiting' });
            const game = games.get(player.gameId);
            if (!game) return sendJSON(res, { status: 'ended' });

            const isP1 = (game.p1 === pid);
            const opponentId = isP1 ? game.p2 : game.p1;
            const opponent = players.get(opponentId);
            const opTeam = opponent ? opponent.team : "";

            const myAction = isP1 ? game.p1Action : game.p2Action;
            const opAction = isP1 ? game.p2Action : game.p1Action;
            
            const iAmConfirmed = isP1 ? game.p1Confirmed : game.p2Confirmed;
            const chatObj = game.latestChat || { sender: "", msg: "", timestamp: 0 };

            // SAFETY: If I am confirmed, I must wait for the other player.
            if (iAmConfirmed) return sendJSON(res, { status: 'syncing', chat: chatObj });

            // TURN READY
            if (game.p1Action && game.p2Action) {
                return sendJSON(res, { 
                    status: 'turn_ready', 
                    gameId: game.id, 
                    turn: game.turn, // Client MUST sync this
                    seed: game.seed,
                    myMoveType: myAction.type, myMoveIndex: myAction.index,
                    opMoveType: opAction.type, opMoveIndex: opAction.index,
                    myQueuedSwitch: myAction.queuedSwitch || 0,
                    opQueuedSwitch: opAction.queuedSwitch || 0,
                    opHpState: opAction.hpState || "", 
                    opponentTeam: opTeam,
                    chat: chatObj 
                });
            }

            return sendJSON(res, { 
                status: 'battle_ongoing', 
                gameId: game.id,        
                seed: game.seed,        
                opponentTeam: opTeam,   
                waitingForOpponent: (myAction !== null),
                chat: chatObj 
            });
        }

        // --- 3. ACTION (STRICT VALIDATION ADDED) ---
        if (url === '/action' && req.method === 'POST') {
            const game = games.get(data.gameId);
            if (!game) return sendJSON(res, { error: 'No game' });

            // *** FIX: Strict Turn Validation ***
            // If client sends action for Turn 2, but server is on Turn 1, ignore it.
            // Or if client re-sends Turn 1 action, allow it (idempotency).
            if (data.turn && data.turn !== game.turn) {
                console.log(`${ts()} REJECTED ACTION: Client Turn ${data.turn} != Server Turn ${game.turn}`);
                return sendJSON(res, { error: 'turn_mismatch', serverTurn: game.turn });
            }

            const payload = { 
                type: data.actionType, 
                index: data.index, 
                queuedSwitch: data.queuedSwitch || 0,
                hpState: data.hpState || "" 
            };

            if (game.p1 === data.id) game.p1Action = payload;
            else if (game.p2 === data.id) game.p2Action = payload;

            return sendJSON(res, { status: 'ok' });
        }

        // --- 4. CHAT ---
        if (url === '/chat' && req.method === 'POST') {
            const game = games.get(data.gameId);
            if (game) {
                game.latestChat = { sender: data.id, msg: data.msg, timestamp: Date.now() };
            }
            return sendJSON(res, { status: 'ok' });
        }

        // --- 5. CONFIRM TURN ---
        if (url === '/confirm_turn' && req.method === 'POST') {
            const { gameId, id } = data;
            const game = games.get(gameId);
            if (game) {
                if (game.p1 === id) game.p1Confirmed = true;
                if (game.p2 === id) game.p2Confirmed = true;
                
                // Only advance turn if BOTH confirmed
                if (game.p1Confirmed && game.p2Confirmed) {
                    console.log(`${ts()} NEW TURN: Turn ${game.turn + 1} Started`);
                    game.p1Action = null; game.p2Action = null;
                    game.p1Confirmed = false; game.p2Confirmed = false;
                    game.turn++;
                }
            }
            return sendJSON(res, { status: 'ok' });
        }

        // --- 6. LEAVE ---
        if (url === '/leave' && req.method === 'POST') {
            players.delete(data.id);
            if(data.gameId) games.delete(data.gameId);
            return sendJSON(res, { status: 'ok' });
        }

        res.writeHead(404); res.end();
    });
});

server.listen(3000, () => console.log('Battle Server (Port 3000) - Strict Mode'));