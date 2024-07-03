const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');

const app = express();
const PORT = 5000;
<<<<<<< HEAD
const SPIN_INTERVAL = 60000; // 60 seconds
=======
const SPIN_INTERVAL = 60000;
>>>>>>> bab9801 (update)

app.use(cors());

const server = app.listen(PORT, () => {
<<<<<<< HEAD
  console.log(`Server is running on http://localhost:${PORT}`);
=======
  console.log(`Server is running on ${PORT}`);
>>>>>>> bab9801 (update)
});

const wss = new WebSocketServer({ server });

<<<<<<< HEAD
let currentNumber = Math.floor(Math.random() * 36);
=======
let currentNumber = Math.floor(Math.random() * 36) + 1;
>>>>>>> bab9801 (update)
let timeToSpin = SPIN_INTERVAL;

const broadcast = (data) => {
  const payload = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === client.OPEN) {
      client.send(payload);
    }
  });
};

wss.on('connection', (ws) => {
  console.log('Client connected');
  ws.send(JSON.stringify({ number: currentNumber, timeRemaining: timeToSpin }));

  ws.on('close', () => {
    console.log('Client disconnected');
  });
});

setInterval(() => {
  if (timeToSpin > 0) {
    timeToSpin -= 1000;
    broadcast({ timeRemaining: timeToSpin });
  } else {
    timeToSpin = SPIN_INTERVAL;
<<<<<<< HEAD
    currentNumber = Math.floor(Math.random() * 36);
    broadcast({ number: currentNumber, timeRemaining: timeToSpin });
  }
}, 1000);
=======
    currentNumber = Math.floor(Math.random() * 36) + 1;
    broadcast({ number: currentNumber, timeRemaining: timeToSpin });
  }
}, 1000);

// Health check endpoint for UptimeRobot
app.get('/health', (req, res) => {
    res.status(200).send('OK');
  });
>>>>>>> bab9801 (update)
