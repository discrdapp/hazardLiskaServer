const express = require('express')
const cors = require('cors')
const { WebSocketServer, WebSocket } = require('ws')
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb')
const bcrypt = require('bcrypt')
const jwt = require('jsonwebtoken')
require('dotenv').config()

const uri = process.env.MONGO_URI

const app = express()
const PORT = process.env.PORT || 5000
const SPIN_INTERVAL = 15000
const SPINNING_TIME = 5000 // 5 seconds for spinning phase

app.use(cors())
app.use(express.json())

const server = app.listen(PORT, () => {
	console.log(`Server is running on ${PORT}`)
})

const wss = new WebSocketServer({ server })

let currentNumber = 0
let timeToSpin = SPIN_INTERVAL
let lastNumbers = [0]
let bets = []
let spinning = false
let processing = false
let winningBets = [] // Array to store winning bets
let battlesArray = []

const clients = new Map() // Map to store clients by ID

const broadcast = data => {
	const payload = JSON.stringify(data)

	wss.clients.forEach(client => {
		if (client.readyState === WebSocket.OPEN) {
			client.send(payload, err => {
				if (err) {
					console.error('WebSocket send error:', err)
				}
			})
		} else {
			console.warn('Client not ready:', client)
		}
	})
}

wss.on('connection', ws => {
	console.log('Client connected')

	// For this example, assume the client sends an ID on connection
	ws.on('message', message => {
		const { id } = JSON.parse(message)
		if (id) {
			clients.set(id, ws)
			ws.send(JSON.stringify({ message: 'Welcome!' }))
		}
	})

	ws.on('close', () => {
		console.log('Client disconnected')
		// Remove client from map when disconnected
		clients.forEach((client, id) => {
			if (client === ws) {
				clients.delete(id)
			}
		})
	})
})

const sendMessageToUsers = (userIds, message) => {
	userIds.forEach(userId => {
		const userWs = clients.get(userId)
		if (userWs) {
			if (userWs.readyState === WebSocket.OPEN) {
				userWs.send(JSON.stringify(message), err => {
					if (err) {
						console.error(`Error sending message to user ${userId}:`, err)
					}
				})
			} else {
				console.warn(`User ${userId} is not ready.`)
			}
		} else {
			console.warn(`No WebSocket found for user ${userId}.`)
		}
	})
}

// Health check endpoint for UptimeRobot
app.get('/health', (req, res) => {
	res.status(200).send('OK')
})

// Connect to MongoDB
const client = new MongoClient(uri, {
	serverApi: {
		version: ServerApiVersion.v1,
		strict: true,
		deprecationErrors: true,
	},
})

async function connectToMongoDB() {
	try {
		await client.connect()
		console.log('Connected to MongoDB')
		const db = client.db('hazardLiska')
		const usersCollection = db.collection('users')
		const inventoryCollection = db.collection('inventory')
		const casesCollection = db.collection('cases')
		const battlesHistoryCollection = db.collection('battlesHistory')
		const skinsCollection = db.collection('skins')

		// Register route
		app.post('/register', async (req, res) => {
			const { username, email, password, role = 'user', profileImage = '/defaultpfp.png' } = req.body
			try {
				const normalizedEmail = email.toLowerCase()
				const userExists = await usersCollection.findOne({ email: normalizedEmail })
				if (userExists) {
					return res.status(400).json({ message: 'Email already in use' })
				}
				const hashedPassword = await bcrypt.hash(password, 10)
				const newUser = {
					username,
					email: normalizedEmail,
					password: hashedPassword,
					balance: 0,
					role,
					exp: 0, // Initialize EXP
					level: 1, // Initialize level
					profileImage, // Include profileImage
					createdAt: new Date(),
					inventory: [],
				}
				const result = await usersCollection.insertOne(newUser)
				const token = jwt.sign({ id: result.insertedId, role: newUser.role }, process.env.JWT_SECRET, {
					expiresIn: '7d',
				})
				res.status(201).json({ message: 'User registered successfully', token })
			} catch (error) {
				res.status(500).json({ message: 'Error registering user', error: error.message })
			}
		})

		// Login route
		app.post('/login', async (req, res) => {
			const { email, password } = req.body
			try {
				const normalizedEmail = email.toLowerCase()
				const user = await usersCollection.findOne({ email: normalizedEmail })
				if (!user) {
					return res.status(400).json({ message: 'User not found' })
				}
				const isMatch = await bcrypt.compare(password, user.password)
				if (!isMatch) {
					return res.status(400).json({ message: 'Invalid password' })
				}
				const token = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '7d' })
				res.json({
					message: 'Login successful',
					token,
					user: {
						username: user.username,
						balance: user.balance,
						role: user.role,
						exp: user.exp,
						level: user.level,
						profileImage: user.profileImage,
					},
				})
			} catch (error) {
				res.status(500).json({ message: 'Error logging in', error: error.message })
			}
		})

		// User details route
		app.get('/user/:id', async (req, res) => {
			const userId = req.params.id
			try {
				const user = await usersCollection.findOne({ _id: new ObjectId(userId) })
				if (!user) {
					return res.status(404).json({ message: 'User not found' })
				}
				res.json({
					id: user._id,
					username: user.username,
					balance: user.balance,
					role: user.role,
					exp: user.exp,
					level: user.level,
					profileImage: user.profileImage,
				})
			} catch (error) {
				res.status(500).json({ message: 'Error fetching user details', error: error.message })
			}
		})

		// Place bet route
		app.post('/bet', async (req, res) => {
			const { token, color, amount } = req.body
			try {
				const decoded = jwt.verify(token, process.env.JWT_SECRET)

				const user = await usersCollection.findOne({ _id: new ObjectId(decoded.id) })

				if (spinning) {
					return res.status(400).json({ message: 'The roulette is spinning' })
				}

				if (processing) {
					return res.status(400).json({ message: 'The bets are being processed' })
				}

				if (!user) {
					return res.status(400).json({ message: 'User not found' })
				}

				if (!/^\d+(\.\d{1,2})?$/.test(amount)) {
					return res.status(400).json({ message: 'Amount must have up to two decimal places' })
				}

				if (user.balance < amount) {
					return res.status(400).json({ message: 'Insufficient balance' })
				}

				if (amount <= 0) {
					return res.status(400).json({ message: 'Bet cannot be below 0' })
				}

				// Check if the user already bet on the same color
				const existingBet = bets.find(bet => bet.userId.equals(user._id) && bet.color === color)

				if (existingBet) {
					// Update the existing bet amount
					existingBet.amount += amount
				} else {
					// Add a new bet
					bets.push({
						userId: user._id,
						color,
						amount,
						username: user.username,
						pfp: user.profileImage,
						level: user.level,
						exp: user.exp,
					})
				}

				const newBalance = parseFloat((user.balance - amount).toFixed(2))

				// Use $set to update the balance
				await usersCollection.updateOne({ _id: user._id }, { $set: { balance: newBalance } })

				const updatedUser = await addExp(user._id, amount)

				// Sort bets
				const sortedBets = bets.sort((a, b) => b.amount - a.amount)

				// Single broadcast message
				sendMessageToUsers([user._id.toString()], {
					type: 'updateBalance',
					newBalance: newBalance,
					level: updatedUser.level,
					exp: updatedUser.exp,
				})

				// Broadcast to all connected clients
				broadcast({
					type: 'updateBets',
					bets: sortedBets,
				})

				res.json({ message: 'Bet placed successfully' })
			} catch (error) {
				if (error.name === 'TokenExpiredError') {
					return res.status(401).json({ message: 'Token expired' })
				}
				console.error('JWT verification error:', error.message)
				return res.status(401).json({ message: 'Invalid token' })
			}
		})

		app.get('/fetchRouletteData', async (req, res) => {
			try {
				const sortedBets = bets.sort((a, b) => b.amount - a.amount)
				const redBets = sortedBets.filter(bet => bet.color === 'red')
				const greenBets = sortedBets.filter(bet => bet.color === 'green')
				const blackBets = sortedBets.filter(bet => bet.color === 'black')
				// Assuming lastNumbers and timeRemaining are defined somewhere in your code
				const response = {
					currentNumber,
					redBets,
					greenBets,
					blackBets,
					lastNumbers,
					timeToSpin,
				}

				return res.json(response)
			} catch (error) {
				return res.status(500).json({ message: 'Error fetching data', error: error.message })
			}
		})

		function sleep(ms) {
			return new Promise(resolve => setTimeout(resolve, ms))
		}

		const getColor = num => {
			if (num === 0) return 'green'
			const number = parseInt(num, 10)
			if (number % 2 === 0) return 'black'
			return 'red'
		}

		setInterval(async () => {
			if (processing) {
				return
			}

			if (timeToSpin > 0) {
				timeToSpin -= 1000
				broadcast({ timeRemaining: timeToSpin, spinning: spinning, processing: processing })
			} else {
				if (!spinning) {
					currentNumber = Math.floor(Math.random() * 36)
					lastNumbers.unshift(currentNumber)

					if (lastNumbers.length > 10) {
						lastNumbers.pop()
					}

					spinning = true
					broadcast({ number: currentNumber, spinning: spinning })

					// Simulate spinning time
					await sleep(SPINNING_TIME)

					spinning = false

					processing = true
					broadcast({ spinning: spinning, processing: processing })
					await processBets(getColor(currentNumber))

					bets = []

					await sleep(1000)

					processing = false

					timeToSpin = SPIN_INTERVAL
					broadcast({
						timeRemaining: timeToSpin,
						lastNumbers: lastNumbers,
						processing: processing,
						bets: bets,
					})
				}
			}
		}, 1000)

		const { ObjectId } = require('mongodb') // Ensure you have this import

		async function processBets(winningColor) {
			let winningBets = []

			for (const bet of bets) {
				const user = await usersCollection.findOne({ _id: new ObjectId(bet.userId) })

				if (bet.color === winningColor) {
					const payoutMultiplier = bet.color === 'green' ? 14 : 2
					const payout = bet.amount * payoutMultiplier
					const newBalance = parseFloat((user.balance + payout).toFixed(2))

					// Use $set to update the balance
					await usersCollection.updateOne({ _id: user._id }, { $set: { balance: newBalance } })

					// Prepare the winning bet object to broadcast
					winningBets.push({ userId: user._id, balance: newBalance })

					sendMessageToUsers([user._id.toString()], {
						type: 'updateBalance',
						newBalance: newBalance,
					})
				}
			}
		}

		// Function to fetch skins from MongoDB with pagination, filtering, and sorting
		async function fetchSkinsFromDB(collection, query, skip, limit, sortOrder) {
			try {
				// Fetch skins from MongoDB with pagination, filtering, and sorting
				const skins = await collection.find(query).skip(skip).limit(limit).sort({ price: sortOrder }).toArray()
				return skins
			} catch (error) {
				throw new Error('Error fetching skins from db: ' + error.message)
			}
		}

		// Endpoint to fetch skins with pagination, filtering, sorting, and search
		app.get('/fetchSkins', async (req, res) => {
			try {
				const page = parseInt(req.query.page) || 1
				const limit = parseInt(req.query.limit) || 10
				const category = req.query.category || null
				const rarity = req.query.rarity || null
				const sortOrder = req.query.sortOrder || 1
				const searchTerm = req.query.searchTerm || null

				const collection = db.collection('skins')
				const skip = (page - 1) * limit
				const query = {}

				if (category && category !== 'All Weapons') {
					query.category = category
				}
				if (rarity) {
					query.rarity = rarity
				}
				if (searchTerm) {
					query.name = { $regex: searchTerm, $options: 'i' } // Case-insensitive search
				}
				const skins = await fetchSkinsFromDB(collection, query, skip, limit, sortOrder)
				res.json(skins)
			} catch (err) {
				console.error('Error fetching skins:', err)
				res.status(500).json({ error: 'Internal Server Error' })
			}
		})
		app.post('/uploadCase', async (req, res) => {
			const { name, type, image, skins } = req.body

			try {
				// Calculate total chance and case price
				let totalChance = 0
				let casePrice = 0

				skins.forEach(skin => {
					if (skin.chance < 0 || skin.chance > 100) {
						throw new Error(
							`Invalid chance (${skin.chance}) for skin "${skin.name}". Chance must be between 0 and 100.`
						)
					}
					totalChance += skin.chance
					casePrice += skin.price * (skin.chance / 100) * 1.15
				})

				// Check if total chance is exactly 100
				if (totalChance !== 100) {
					throw new Error(`Total chance (${totalChance}) must equal 100.`)
				}

				const newCase = {
					name,
					type,
					image,
					skins,
					casePrice,
					createdAt: new Date(),
				}

				const result = await casesCollection.insertOne(newCase)
				res.status(201).json({ success: true, message: 'Case uploaded successfully', caseId: result.insertedId })
			} catch (error) {
				res.status(400).json({ success: false, message: 'Error uploading case', error: error.message })
			}
		})

		app.get('/cases', async (req, res) => {
			try {
				const cases = await casesCollection.find({}).toArray()
				res.status(200).json(cases)
			} catch (error) {
				res.status(500).json({ success: false, message: 'Error fetching cases', error: error.message })
			}
		})

		app.get('/cases/:caseId', async (req, res) => {
			const { caseId } = req.params
			try {
				const caseDetail = await casesCollection.findOne({ _id: new ObjectId(caseId) })
				if (!caseDetail) {
					return res.status(404).json({ success: false, message: 'Case not found' })
				}
				res.status(200).json(caseDetail)
			} catch (error) {
				res.status(500).json({ success: false, message: 'Error fetching case detail', error: error.message })
			}
		})
		// Route to open a case
		app.post('/cases/:caseId/open', async (req, res) => {
			const { caseId } = req.params
			const { userId, numCases } = req.body
			const inventoryCollection = db.collection('inventory')
			const usersCollection = db.collection('users')
			const transactionsCollection = db.collection('Transakcje')

			try {
				// Find the case data
				const caseData = await casesCollection.findOne({ _id: new ObjectId(caseId) })
				if (!caseData) {
					return res.status(404).json({ success: false, message: 'Case not found' })
				}

				// Extract case price
				const casePrice = caseData.casePrice
				const totalCost = casePrice * numCases

				// Find the user and check if they have enough balance
				const user = await usersCollection.findOne({ _id: new ObjectId(userId) })
				if (!user) {
					return res.status(404).json({ success: false, message: 'User not found' })
				}
				if (user.balance < totalCost) {
					return res.status(404).json({ success: false, message: 'Insufficient balance' })
				}

				// Deduct the cost from the user's balance
				const newBalance = user.balance - totalCost
				await usersCollection.updateOne({ _id: new ObjectId(userId) }, { $set: { balance: newBalance } })

				// Add EXP and check for level up
				const updatedUser = await addExp(userId, totalCost)

				// Process skins
				const skins = caseData.skins
				const wonSkins = []

				for (let i = 0; i < numCases; i++) {
					// Calculate total chances
					const totalChances = skins.reduce((sum, skin) => sum + skin.chance, 0)
					const randomChance = Math.random() * totalChances
					let cumulativeChance = 0
					let selectedSkin = null

					// Select a skin based on the chance
					for (const skin of skins) {
						cumulativeChance += skin.chance
						if (randomChance <= cumulativeChance) {
							selectedSkin = { ...skin } // Create a shallow copy to modify
							break
						}
					}

					if (!selectedSkin) {
						return res.status(500).json({ success: false, message: 'Error selecting skin' })
					}

					// Remove _id field and add a new unique identifier
					const { _id, chance, estimatedPriceSkin, ...cleanSkin } = selectedSkin
					cleanSkin._id = new ObjectId() // Generate a new unique identifier
					cleanSkin.userId = new ObjectId(userId) // Add userId reference

					// Add the selected skin to the inventory collection
					const inventoryInsertResult = await inventoryCollection.insertOne(cleanSkin)

					if (!inventoryInsertResult.insertedId) {
						return res.status(500).json({ success: false, message: 'Error updating user inventory' })
					}

					wonSkins.push(cleanSkin)
				}

				// Add transaction record
				const transaction = {
					userId: new ObjectId(userId),
					amount: -totalCost,
					balance: newBalance,
					action: numCases > 1 ? 'Otworzono wiele skrzynek' : 'Otworzono skrzynke',
					destination: '/case/' + caseId,
					timestamp: new Date(),
				}
				await transactionsCollection.insertOne(transaction)

				res.status(200).json({
					success: true,
					skins: wonSkins,
					newBalance: newBalance,
					level: updatedUser.level,
					exp: updatedUser.exp,
				})
			} catch (error) {
				res.status(500).json({ success: false, message: 'Error opening case', error: error.message })
			}
		})
		app.post('/user/:userId/sell', async (req, res) => {
			const { userId } = req.params
			const { skinId } = req.body // ID of the skin to sell
			const usersCollection = db.collection('users')
			const inventoryCollection = db.collection('inventory')
			const inventoryHistoryCollection = db.collection('inventoryHistory')
			const transactionsCollection = db.collection('Transakcje')

			try {
				// Find the user
				const user = await usersCollection.findOne({ _id: new ObjectId(userId) })
				if (!user) {
					return res.status(404).json({ message: 'User not found' })
				}

				// Find the skin in the inventory collection
				const skin = await inventoryCollection.findOne({ _id: new ObjectId(skinId), userId: new ObjectId(userId) })
				if (!skin) {
					return res.status(404).json({ message: 'Skin already sold or not found in inventory' })
				}

				// Calculate new balance
				const newBalance = user.balance + skin.price

				// Update the user's balance
				await usersCollection.updateOne({ _id: new ObjectId(userId) }, { $set: { balance: newBalance } })

				// Remove the skin from the inventory collection
				await inventoryCollection.deleteOne({ _id: new ObjectId(skinId) })

				// Check the number of entries in inventoryHistory for the user
				const historyCount = await inventoryHistoryCollection.countDocuments({ userId: new ObjectId(userId) })

				// Remove oldest entries if the count exceeds 500
				if (historyCount >= 500) {
					const excessCount = historyCount - 499 // Calculate how many entries need to be removed
					await inventoryHistoryCollection.deleteMany(
						{ userId: new ObjectId(userId) },
						{ sort: { soldAt: 1 }, limit: excessCount }
					)
				}

				// Add skin to inventory history with status 'sprzedano'
				const historyEntry = { ...skin, userId: new ObjectId(userId), status: 'sprzedano', soldAt: new Date() }
				await inventoryHistoryCollection.insertOne(historyEntry)

				// Add transaction record
				const transaction = {
					userId: new ObjectId(userId),
					amount: skin.price,
					balance: newBalance,
					action: 'Sprzedano skina',
					timestamp: new Date(),
				}
				await transactionsCollection.insertOne(transaction)

				res.status(200).json({ message: 'Skin sold', newBalance: newBalance })
			} catch (error) {
				res.status(500).json({ message: 'Error selling skin', error: error.message })
			}
		})

		app.post('/user/:userId/sellAll', async (req, res) => {
			const { userId } = req.params
			const { skins } = req.body // Array of skin IDs to sell
			const usersCollection = db.collection('users')
			const inventoryCollection = db.collection('inventory')
			const inventoryHistoryCollection = db.collection('inventoryHistory')
			const transactionsCollection = db.collection('Transakcje')

			try {
				// Find the user
				const user = await usersCollection.findOne({ _id: new ObjectId(userId) })
				if (!user) {
					return res.status(404).json({ message: 'User not found' })
				}

				// Convert skin IDs to ObjectId
				const skinIdsToSell = skins.map(id => new ObjectId(id))

				// Find all the skins in the inventory collection
				const skinsToSell = await inventoryCollection
					.find({ _id: { $in: skinIdsToSell }, userId: new ObjectId(userId) })
					.toArray()
				if (skinsToSell.length === 0) {
					return res.status(404).json({ message: 'Skins already sold or not found in inventory' })
				}

				// Calculate total sell price
				const totalSellPrice = skinsToSell.reduce((sum, skin) => sum + skin.price, 0)
				const newBalance = user.balance + totalSellPrice

				// Update the user's balance
				await usersCollection.updateOne({ _id: new ObjectId(userId) }, { $set: { balance: newBalance } })

				// Remove the skins from the inventory collection
				await inventoryCollection.deleteMany({ _id: { $in: skinIdsToSell } })

				// Check the number of entries in inventoryHistory for the user
				const historyCount = await inventoryHistoryCollection.countDocuments({ userId: new ObjectId(userId) })

				// Remove oldest entries if the count will exceed 500
				const entriesToAdd = skinsToSell.length
				if (historyCount + entriesToAdd > 500) {
					const excessCount = historyCount + entriesToAdd - 500
					const excessEntries = await inventoryHistoryCollection
						.find({ userId: new ObjectId(userId) })
						.sort({ soldAt: 1 })
						.limit(excessCount)
						.toArray()
					const excessEntryIds = excessEntries.map(entry => entry._id)
					await inventoryHistoryCollection.deleteMany({ _id: { $in: excessEntryIds } })
				}

				// Add skins to inventory history with status 'sprzedano'
				const historyEntries = skinsToSell.map(skin => ({
					...skin,
					userId: new ObjectId(userId),
					status: 'sprzedano',
					soldAt: new Date(),
				}))
				await inventoryHistoryCollection.insertMany(historyEntries)

				// Add transaction record
				const transaction = {
					userId: new ObjectId(userId),
					amount: totalSellPrice,
					balance: newBalance,
					action: 'Sprzedano wiele skinów',
					timestamp: new Date(),
				}
				await transactionsCollection.insertOne(transaction)

				res.status(200).json({ message: 'All selected skins sold', newBalance: newBalance })
			} catch (error) {
				res.status(500).json({ message: 'Error selling skins', error: error.message })
			}
		})

		// User details route
		app.get('/profile/:id', async (req, res) => {
			const userId = req.params.id
			try {
				const user = await usersCollection.findOne({ _id: new ObjectId(userId) })
				if (!user) {
					return res.status(404).json({ message: 'User not found' })
				}
				const inventory = await (await inventoryCollection.find({ userId: new ObjectId(userId) }).toArray()).reverse()
				res.json({
					id: user._id,
					username: user.username,
					balance: user.balance,
					role: user.role,
					exp: user.exp,
					level: user.level,
					inventory: inventory,
					profileImage: user.profileImage,
				})
			} catch (error) {
				res.status(500).json({ message: 'Error fetching user details', error: error.message })
			}
		})
		const baseExp = 100
		const getExpForNextLevel = level => {
			return baseExp * Math.pow(level, 2)
		}

		const addExp = async (userId, amountSpent) => {
			const user = await usersCollection.findOne({ _id: new ObjectId(userId) })
			if (!user) throw new Error('User not found')

			user.exp = parseFloat(user.exp)
			user.level = parseFloat(user.level)
			user.exp += amountSpent // 1 dollar spent = 1 EXP
			let expForNextLevel = getExpForNextLevel(user.level)

			while (user.exp >= expForNextLevel) {
				user.exp -= expForNextLevel
				user.level += 1
				expForNextLevel = getExpForNextLevel(user.level)
			}

			await usersCollection.updateOne({ _id: new ObjectId(userId) }, { $set: { exp: user.exp, level: user.level } })

			return user
		}

		app.get('/user/:userId/inventoryHistory', async (req, res) => {
			const { userId } = req.params
			const inventoryHistoryCollection = db.collection('inventoryHistory')

			try {
				// Fetch inventory history for the user
				const inventoryHistory = await (
					await inventoryHistoryCollection.find({ userId: new ObjectId(userId) }).toArray()
				).reverse()
				res.status(200).json(inventoryHistory)
			} catch (error) {
				res.status(500).json({ message: 'Error fetching inventory history', error: error.message })
			}
		})
		app.put('/profile/:id/updateProfileImage', async (req, res) => {
			const userId = req.params.id
			const { profileImage } = req.body

			if (!profileImage) {
				return res.status(400).json({ message: 'No profile image URL provided' })
			}

			try {
				const result = await usersCollection.findOneAndUpdate(
					{ _id: new ObjectId(userId) },
					{ $set: { profileImage: profileImage } },
					{ returnDocument: 'after' }
				)

				if (!result) {
					return res.status(404).json({ message: 'User not found' })
				}

				res.json(result)
			} catch (error) {
				res.status(500).json({ message: 'Error updating profile image', error: error.message })
			}
		})
		app.put('/profile/:id/updateUsername', async (req, res) => {
			const userId = req.params.id
			const { username } = req.body

			if (!username) {
				return res.status(400).json({ message: 'No username provided' })
			}

			try {
				const result = await usersCollection.findOneAndUpdate(
					{ _id: new ObjectId(userId) },
					{ $set: { username: username } },
					{ returnDocument: 'after' }
				)

				if (!result) {
					return res.status(404).json({ message: 'User not found' })
				}

				res.json(result)
			} catch (error) {
				res.status(500).json({ message: 'Error updating username', error: error.message })
			}
		})
		// Route to get paginated transactions for a user
		app.get('/user/:userId/transactions', async (req, res) => {
			const { userId } = req.params
			const { page = 1, limit = 30 } = req.query // Default to page 1 and 30 items per page
			const transactionsCollection = db.collection('Transakcje')

			const pageNumber = parseInt(page)
			const limitNumber = parseInt(limit)
			const skip = (pageNumber - 1) * limitNumber

			try {
				// Find the transactions for the user with pagination
				const transactions = await transactionsCollection
					.find({ userId: new ObjectId(userId) })
					.sort({ timestamp: -1 }) // Sort by most recent
					.skip(skip)
					.limit(limitNumber)
					.toArray()

				const totalTransactions = await transactionsCollection.countDocuments({ userId: new ObjectId(userId) })
				const totalPages = Math.ceil(totalTransactions / limitNumber)

				res.status(200).json({ transactions, totalPages })
			} catch (error) {
				res.status(500).json({ message: 'Error fetching transactions', error: error.message })
			}
		})

		// Function to fetch cases from MongoDB with pagination, filtering, and sorting
		async function fetchCasesFromDB(collection, query, skip, limit) {
			try {
				const cases = await collection.find(query).skip(skip).limit(limit).toArray()
				return cases
			} catch (error) {
				throw new Error('Error fetching cases from db: ' + error.message)
			}
		}

		// Endpoint to fetch cases with pagination, filtering, sorting, and search
		app.get('/fetchCases', async (req, res) => {
			try {
				const page = parseInt(req.query.page) || 1
				const limit = parseInt(req.query.limit) || 10
				const searchTerm = req.query.searchTerm || null
				const category = req.query.category || null
				const lowerBudget = parseFloat(req.query.lowerBudget) || 0
				const upperBudget = parseFloat(req.query.upperBudget) || 50

				const collection = db.collection('cases')
				const skip = (page - 1) * limit
				const query = {}

				if (searchTerm) {
					query.name = { $regex: searchTerm, $options: 'i' } // Case-insensitive search
				}
				if (category) {
					query.type = category
				}
				query.casePrice = { $gte: lowerBudget, $lte: upperBudget }

				const cases = await fetchCasesFromDB(collection, query, skip, limit)
				res.json(cases)
			} catch (err) {
				console.error('Error fetching cases:', err)
				res.status(500).json({ error: 'Internal Server Error' })
			}
		})

		const lastBattleCreationTimes = new Map() // In-memory store for last battle creation times
		const TIME_LIMIT = 5000 // Time limit in milliseconds (e.g., 5 seconds)

		// Route to create a new battle
		app.post('/createBattle', async (req, res) => {
			const { selectedCases, battleType, battleVisibility, battleMode, user } = req.body
			const battlesHistoryCollection = db.collection('battlesHistory')
			const userId = user.id

			// Get the current time
			const currentTime = Date.now()

			// Check if the user has created a battle recently
			if (lastBattleCreationTimes.has(userId)) {
				const { timestamp, timeoutId } = lastBattleCreationTimes.get(userId)
				if (currentTime - timestamp < TIME_LIMIT) {
					return res.status(429).json({
						success: false,
						message: 'You are creating battles too quickly. Please wait a moment and try again.',
					})
				}

				// Clear the existing timeout
				clearTimeout(timeoutId)
			}

			// Create a new timeout to remove the entry after TIME_LIMIT
			const timeoutId = setTimeout(() => {
				lastBattleCreationTimes.delete(userId)
			}, TIME_LIMIT)

			// Store the last creation time and the timeout ID for this user
			lastBattleCreationTimes.set(userId, { timestamp: currentTime, timeoutId })

			// Validate the number of selected cases
			if (selectedCases.length < 1 || selectedCases.length > 100) {
				return res.status(400).json({ success: false, message: 'Number of cases must be between 1 and 100' })
			}

			// Map the selected cases to an array of ObjectIds
			const caseIds = selectedCases.map(caseItem => new ObjectId(caseItem._id))

			let totalCost = 0

			try {
				// Fetch case data for the selected case IDs
				const cases = await casesCollection.find({ _id: { $in: caseIds } }).toArray()
				const caseMap = new Map(cases.map(caseItem => [caseItem._id.toString(), caseItem]))

				// Calculate the total cost of the cases
				for (const caseItem of selectedCases) {
					const caseData = caseMap.get(caseItem._id)
					if (caseData) {
						totalCost += caseData.casePrice
					}
				}
			} catch (error) {
				return res.status(500).json({ success: false, message: 'Error fetching case data', error: error.message })
			}

			try {
				// Only keep the _id field for the user
				const sanitizedUser = { _id: userId }

				// Determine the number of users based on battleMode
				const amountOfPeople =
					battleMode === '1v1'
						? 2
						: battleMode === '1v1v1'
						? 3
						: battleMode === '1v1v1v1'
						? 4
						: battleMode === '2v2'
						? 4
						: battleMode === '2'
						? 2
						: battleMode === '3'
						? 3
						: battleMode === '4'
						? 4
						: 0

				// Initialize users array with the current user
				const users = Array(amountOfPeople).fill(null)
				users[0] = sanitizedUser

				// Create the battle object
				const battle = {
					cases: caseIds, // Using the array of ObjectIds
					type: battleType,
					mode: battleMode,
					visibility: battleVisibility,
					state: 'created',
					battleCost: parseFloat(totalCost.toFixed(2)),
					users: users,
					rolledSkins: [], // To store rolled skins per round
					currentCaseIndex: 0, // Track the current case index
				}

				// Insert the battle into the database
				const insertResult = await battlesHistoryCollection.insertOne(battle)
				if (!insertResult.insertedId) {
					throw new Error('Error inserting battle into database')
				}

				battle._id = insertResult.insertedId
				battlesArray.push(battle)
				broadcast({ action: 'newBattle', battle: battle })

				res.status(200).json({ success: true, message: 'Battle created successfully', path: `/battles/${battle._id}` })
			} catch (error) {
				res.status(500).json({ success: false, message: 'Error creating battle', error: error.message })
			}
		})

		// Route to get all battles
		app.get('/battles', async (req, res) => {
			try {
				// Clone the battlesArray so that the original isn't modified
				const updatedBattles = battlesArray.map(async battle => {
					const userIds = battle.users.map(u => (u ? {_id: u._id} : null))
					
					// Fetch the user details for each battle's users
					const users = await fetchBattleUserDetails(userIds)

					// Update the battle's users field with the fetched user details
					return {
						...battle,
						users: users.map((user, index) => (user ? user : battle.users[index])), // Preserve nulls if any
					}
				})

				// Wait for all battles to be updated
				const resolvedBattles = await Promise.all(updatedBattles)

				// Send the updated battles array as a response
				res.status(200).json({ success: true, battles: resolvedBattles })
			} catch (error) {
				console.error('Error fetching battles:', error)
				res.status(500).json({ success: false, message: 'Failed to fetch battles.' })
			}
		})

		const sanitizeUser = user => ({
			_id: user._id,
			username: user.username,
			role: user.role,
			exp: user.exp,
			level: user.level,
			profileImage: user.profileImage,
			bot: user.bot ? true : false,
		})

		const fetchBattleUserDetails = async userIds => {
			// Separate ObjectId instances from user objects
			const validUserIds = userIds
				.filter(id => id && typeof id === 'object' && !id.bot && id._id)
				.map(id => new ObjectId(id._id))
			const objectIdInstances = userIds.filter(id => id && typeof id === 'object' && id instanceof ObjectId)

			// Merge both types of valid ids for database query
			const combinedUserIds = [...validUserIds, ...objectIdInstances]

			// Fetch users from the database using the combined list
			const usersFromDb = await usersCollection.find({ _id: { $in: combinedUserIds } }).toArray()

			// Sanitize user data and convert to a map for quick lookup
			const userMap = new Map(usersFromDb.map(user => [user._id.toString(), sanitizeUser(user)]))

			// Return sanitized users in the order of userIds, preserving nulls and including bot objects directly
			return userIds.map(id => {
				if (!id) return null // Return null if id is null or undefined
				if (id.bot) return id // Return bot object directly
				if (id instanceof ObjectId) return userMap.get(id.toString()) || null // Handle ObjectId instances
				return userMap.get(id._id.toString()) || null // Handle user objects with _id
			})
		}

		app.get('/battle/:id', async (req, res) => {
			const { id } = req.params
			let battle = battlesArray.find(b => b._id.toString() === id)

			const sanitizeSkins = skins => {
				return skins.map(skin => {
					const { estimatedPriceSkin, ...sanitizedSkin } = skin
					return sanitizedSkin
				})
			}

			if (battle) {
				const uniqueCaseIds = [...new Set(battle.cases)]
				const SkinsCases = await casesCollection
					.find({ _id: { $in: uniqueCaseIds.map(id => new ObjectId(id)) } })
					.toArray()

				// Sanitize skins for each case
				const sanitizedCases = SkinsCases.map(skinCase => ({
					...skinCase,
					skins: sanitizeSkins(skinCase.skins),
				}))

				// Get the user IDs directly from the battle.users array, including bots
				const userIds = battle.users.map(u => (u ? u : null)) // No change needed here

				const users = await fetchBattleUserDetails(userIds)

				res.status(200).json({
					success: true,
					battle: battle,
					SkinsCases: sanitizedCases,
					users: users,
					source: 'server',
				})
			} else {
				battle = await battlesHistoryCollection.findOne({ _id: new ObjectId(id) })
				if (battle) {
					const uniqueCaseIds = [...new Set(battle.cases)]
					const cases = await casesCollection
						.find({ _id: { $in: uniqueCaseIds.map(id => new ObjectId(id)) } })
						.toArray()

					// Sanitize skins for each case
					const sanitizedCases = cases.map(skinCase => ({
						...skinCase,
						skins: sanitizeSkins(skinCase.skins),
					}))

					// Get the user IDs directly from the battle.users array, including bots
					const userIds = battle.users.map(u => (u ? u : null)) // No change needed here

					const users = await fetchBattleUserDetails(userIds)

					res.status(200).json({
						success: true,
						battle,
						SkinsCases: sanitizedCases,
						users: users,
						source: 'database',
					})
				} else {
					res.status(404).json({ success: false, message: 'Battle not found' })
				}
			}
		})

		app.post('/joinBattle/:id', async (req, res) => {
			const { id } = req.params
			const { user, index } = req.body

			try {
				let battle = battlesArray.find(b => b._id.toString() === id)
				if (!battle) {
					battle = await battlesHistoryCollection.findOne({ _id: new ObjectId(id) })
					if (!battle) {
						return res.status(404).json({ success: false, message: 'Battle not found' })
					}
					battlesArray.push(battle)
				}

				if (battle.users.some(existingUser => existingUser && existingUser._id === user.id)) {
					return res.status(400).json({ success: false, message: 'You are already in this battle' })
				}

				// Check if the provided index is valid
				if (index < 0 || index >= battle.users.length || battle.users[index] !== null) {
					return res.status(400).json({ success: false, message: 'Invalid index or position already occupied' })
				}

				// Only keep the _id field for the user
				const sanitizedUser = { _id: user.id }
				battle.users[index] = sanitizedUser

				// Fetch full user details in the order of their positions in the battle
				const userIds = battle.users.map(u => (u ? new ObjectId(u._id) : null))
				const usersFromDb = await usersCollection.find({ _id: { $in: userIds.filter(id => id !== null) } }).toArray()

				// Map fetched users back to their positions in the battle.users array
				const usersInOrder = userIds.map(id => usersFromDb.find(user => user._id.equals(id)))

				// Sanitize users before broadcasting
				const sanitizedUsers = usersInOrder.map(user => (user ? sanitizeUser(user) : null))

				// Broadcast the updated battle with sanitized user details
				broadcast({ action: 'updateBattle', battle: battle, users: sanitizedUsers })

				res.status(200).json({ success: true, message: 'Joined battle successfully' })

				if (battle.users.every(u => u !== null)) {
					battle.state = 'ready'
					await startBattle(battle)
				}
			} catch (error) {
				console.error('Error joining battle:', error)
				res.status(500).json({ success: false, message: 'Error joining battle', error: error.message })
			}
		})

		// Function to start the battle
		const startBattle = async battle => {
			try {
				// Sanitize skins in a case
				const sanitizeSkins = skins => {
					return skins.map(skin => {
						const { estimatedPriceSkin, ...sanitizedSkin } = skin
						return sanitizedSkin
					})
				}

				// Fetch and sanitize all unique cases at once
				const uniqueCaseIds = [...new Set(battle.cases)]
				const skinsCases = await casesCollection
					.find({ _id: { $in: uniqueCaseIds.map(id => new ObjectId(id)) } })
					.toArray()

				// Sanitize skins for each case
				const sanitizedCases = skinsCases.map(skinCase => ({
					...skinCase,
					skins: sanitizeSkins(skinCase.skins),
				}))

				// Function to update countdown and broadcast
				const updateCountdown = async (battle, countdown) => {
					battle.countdown = countdown
					broadcast({ action: 'countdown', battle: battle })
					await new Promise(res => setTimeout(res, 1000))
				}

				// Start countdown from 3 to 1
				await updateCountdown(battle, 3)
				await updateCountdown(battle, 2)
				await updateCountdown(battle, 1)

				// Set battle to rolling state and broadcast
				battle = { ...battle, state: 'rolling', countdown: null }
				battlesArray = battlesArray.map(battleItem => (battleItem._id.equals(battle._id) ? battle : battleItem))

				for (let caseIndex = 0; caseIndex < battle.cases.length; caseIndex++) {
					battle.currentCaseIndex = caseIndex

					// Roll items for the current case
					await rollItemsForBattle(battle, sanitizedCases)

					// Wait for a brief period before rolling the next case
					await new Promise(res => setTimeout(res, 3000))
				}

				// Finalize the battle once all cases have been rolled
				battle.state = 'finished'
				await finalizeBattle(battle)
			} catch (error) {
				console.error('Error starting battle:', error)
			}
		}

		// Function to roll items for the current case in the battle
		const rollItemsForBattle = async (battle, sanitizedCases) => {
			try {
				const caseId = battle.cases[battle.currentCaseIndex]
				const caseData = sanitizedCases.find(skinCase => skinCase._id.equals(caseId))

				if (!caseData) return

				const rolledSkins = battle.users.map(user => {
					if (user) {
						return rollItems(caseData.skins, 1)[0] // Roll one item per user
					}
					return null
				})

				battle.rolledSkins.push(rolledSkins)

				// Broadcast the roll results to all clients
				broadcast({ action: 'rollItems', battle })
			} catch (error) {
				console.error('Error rolling items for battle:', error)
			}
		}

		// Function to roll items randomly from the available skins in the case
		const rollItems = (skins, numItems) => {
			const rolledItems = []
			for (let i = 0; i < numItems; i++) {
				const totalChances = skins.reduce((sum, skin) => sum + skin.chance, 0)
				const randomChance = Math.random() * totalChances
				let cumulativeChance = 0
				let selectedSkin = null

				for (const skin of skins) {
					cumulativeChance += skin.chance
					if (randomChance <= cumulativeChance) {
						selectedSkin = { ...skin }
						break
					}
				}

				rolledItems.push(selectedSkin)
			}
			return rolledItems
		}

		const finalizeBattle = async battle => {
			try {
				const wonSkins = {}
				const userTotalValues = {}
				const userAllocatedSkins = {}

				// Aggregate all won skins per user and calculate their total value
				battle.rolledSkins.forEach(roundSkins => {
					roundSkins.forEach((skin, userIndex) => {
						if (skin) {
							const user = battle.users[userIndex]
							const userId = user._id
							wonSkins[userId] = wonSkins[userId] || []
							wonSkins[userId].push(skin)

							userTotalValues[userId] = userTotalValues[userId] || 0
							userTotalValues[userId] += skin.price
						}
					})
				})

				let winnerIds = []
				let isTie = false

				const calculateSkinDistribution = (totalValue, numberOfPlayers) => {
					return totalValue / numberOfPlayers
				}

				const allocateSkins = async (userId, shareValue) => {
					let allocatedSkins = []
					let remainingValue = shareValue
					const maxSkins = 10

					while (remainingValue > 0 && allocatedSkins.length < maxSkins) {
						let expensiveSkins = await skinsCollection
							.find({ price: { $lte: remainingValue } })
							.sort({ price: -1 })
							.limit(1)
							.toArray()

						// If no skins are found within the remaining value, get the cheapest skin
						if (expensiveSkins.length === 0) {
							expensiveSkins = await skinsCollection.find({}).sort({ price: 1 }).limit(1).toArray()
						}

						if (expensiveSkins.length > 0) {
							const selectedSkin = expensiveSkins[0]
							allocatedSkins.push(selectedSkin)
							remainingValue -= selectedSkin.price
						} else {
							break // Break the loop if no skins can be allocated
						}
					}

					// If there's any remaining value, allocate it as "Balance"
					if (remainingValue > 0) {
						allocatedSkins.push({
							name: 'Balance',
							price: remainingValue,
							rarity: 'Money',
							image: '/difference_money.png',
						})
					}

					// Store the allocated skins for the user
					userAllocatedSkins[userId] = allocatedSkins
				}

				const allocateLossSkins = async (userId, battleCost) => {
					const lossShareValue = battleCost * 0.01
					await allocateSkins(userId, lossShareValue)
				}

				if (battle.type === 'Razem') {
					const totalValue = Object.values(userTotalValues).reduce((acc, value) => acc + value, 0)
					const sharedValue = calculateSkinDistribution(totalValue, battle.users.length)

					for (let user of battle.users) {
						await allocateSkins(user._id, sharedValue)
					}

					winnerIds = battle.users // Store full user objects or bot objects
				} else if (battle.mode === '2v2') {
					const team1Total = userTotalValues[battle.users[0]._id] + userTotalValues[battle.users[2]._id]
					const team2Total = userTotalValues[battle.users[1]._id] + userTotalValues[battle.users[3]._id]

					const totalBattleValue = team1Total + team2Total
					const winningTeamShare = calculateSkinDistribution(totalBattleValue, 2)

					if (team1Total === team2Total) {
						isTie = true
						const randomness = Math.random()
						winnerIds = randomness < 0.5 ? [battle.users[0], battle.users[2]] : [battle.users[1], battle.users[3]]
						const losingIds = randomness < 0.5 ? [battle.users[1], battle.users[3]] : [battle.users[0], battle.users[2]]
						await allocateSkins(winnerIds[0]._id, winningTeamShare)
						await allocateSkins(winnerIds[1]._id, winningTeamShare)

						for (let user of losingIds) {
							await allocateLossSkins(user._id, battle.battleCost)
						}
					} else {
						const compareTeamValue =
							battle.type === 'Standardowy' ? Math.max(team1Total, team2Total) : Math.min(team1Total, team2Total)

						const winningTeamUsers =
							compareTeamValue === team1Total ? [battle.users[0], battle.users[2]] : [battle.users[1], battle.users[3]]
						const losingTeamUsers =
							compareTeamValue === team1Total ? [battle.users[1], battle.users[3]] : [battle.users[0], battle.users[2]]

						await allocateSkins(winningTeamUsers[0]._id, winningTeamShare)
						await allocateSkins(winningTeamUsers[1]._id, winningTeamShare)

						for (let user of losingTeamUsers) {
							await allocateLossSkins(user._id, battle.battleCost)
						}

						winnerIds = winningTeamUsers // Store full user objects or bot objects
					}
				} else if (['1v1', '1v1v1', '1v1v1v1'].includes(battle.mode)) {
					const isStandardMode = battle.type === 'Standardowy'

					// Determine the compare value based on the mode
					const compareValue = isStandardMode
						? Math.max(...Object.values(userTotalValues)) // Standard mode: Max value wins
						: Math.min(...Object.values(userTotalValues)) // Crazy mode: Min value wins

					// Identify potential winners based on compare value
					const potentialWinners = battle.users.filter(user => userTotalValues[user._id] === compareValue)

					// Check if there's a tie
					if (potentialWinners.length > 1) {
						isTie = true
						// Randomly select one of the tied players as the winner
						const randomWinner = potentialWinners[Math.floor(Math.random() * potentialWinners.length)]
						winnerIds = [randomWinner]
					} else {
						winnerIds = [potentialWinners[0]]
					}

					for (let winner of winnerIds) {
						userAllocatedSkins[winner._id] = [] // Initialize winner's skins array
						battle.rolledSkins.forEach(roundSkins => {
							userAllocatedSkins[winner._id] = userAllocatedSkins[winner._id].concat(roundSkins)
						})
					}

					// Identify and allocate loss skins to the losers (excluding winners)
					const losingUsers = battle.users.filter(user => !winnerIds.includes(user))
					for (let loser of losingUsers) {
						await allocateLossSkins(loser._id, battle.battleCost)
					}
				}

				// Fetch user details, bots included directly
				const winnerDetails = await fetchBattleUserDetails(winnerIds)

				const sanitizedWinners = winnerDetails.map(user => (user ? sanitizeUser(user) : null))

				await battlesHistoryCollection.updateOne(
					{ _id: battle._id },
					{
						$set: {
							state: 'finished',
							rolledSkins: battle.rolledSkins,
							winnerIds: winnerIds.map(user => (user._id || user.bot ? user : null)), // Store the winner(s)
							users: battle.users,
							isTie: isTie, // Indicate if there was a tie
							allocatedSkins: userAllocatedSkins, // Store the allocated skins
						},
					}
				)

				const battleIndex = battlesArray.findIndex(b => b._id.equals(battle._id))
				if (battleIndex > -1) {
					battlesArray.splice(battleIndex, 1)
				}

				broadcast({
					action: 'battleEnded',
					battle,
					winners: sanitizedWinners,
					isTie: isTie,
					allocatedSkins: userAllocatedSkins,
				})
			} catch (error) {
				console.error('Error finalizing battle:', error)
			}
		}

		app.post('/addBot/:id', async (req, res) => {
			const { id } = req.params
			const { user, index } = req.body

			try {
				let battle = battlesArray.find(b => b._id.toString() === id)
				if (!battle) {
					battle = await battlesHistoryCollection.findOne({ _id: new ObjectId(id) })
					if (!battle) {
						return res.status(404).json({ success: false, message: 'Battle not found' })
					}
					battlesArray.push(battle)
				}

				// Ensure only the creator (first user) can add a bot
				if (battle.users[0]._id.toString() !== user.id) {
					return res.status(403).json({ success: false, message: 'Only the battle creator can add a bot' })
				}

				// Check if the provided index is valid and the slot is empty
				if (index < 0 || index >= battle.users.length || battle.users[index] !== null) {
					return res.status(400).json({ success: false, message: 'Invalid index or position already occupied' })
				}

				const botNames = ['Skibidi', 'Sigma', 'Bali', 'Japko']

				// Filter out bot names that have already been used in this battle
				const usedNames = battle.users.filter(u => u && u.bot).map(u => u.username)
				const availableBotNames = botNames.filter(name => !usedNames.includes(name))

				// Check if there are available bot names left
				if (availableBotNames.length === 0) {
					return res.status(400).json({ success: false, message: 'No bot names available' })
				}

				// Select a random bot name from the remaining available names
				const botName = availableBotNames[Math.floor(Math.random() * availableBotNames.length)]

				// Create a bot user object
				const botUser = {
					_id: new ObjectId(),
					username: `${botName}`,
					level: 1,
					exp: 0,
					profileImage: `/boty/bot${botName}.png`, // Dynamic profile image based on bot name
					bot: true, // Mark this user as a bot
				}

				// Add the bot to the specified index in the users array
				battle.users[index] = botUser

				// Skip database fetching for bots, only fetch real users from DB
				const userIds = battle.users.map(u => (u && !u.bot ? new ObjectId(u._id) : null))
				const usersFromDb = await usersCollection.find({ _id: { $in: userIds.filter(id => id !== null) } }).toArray()

				// Combine database users with bots
				const usersInOrder = battle.users.map(user => {
					if (user && user.bot) {
						return user // Keep the bot user as is
					}
					return usersFromDb.find(dbUser => dbUser._id.equals(user ? user._id : null))
				})

				// Sanitize users before broadcasting
				const sanitizedUsers = usersInOrder.map(user => (user ? sanitizeUser(user) : null))

				// Broadcast the updated battle with sanitized user details
				broadcast({ action: 'updateBattle', battle: battle, users: sanitizedUsers })

				res.status(200).json({ success: true, message: 'Bot added successfully' })

				// If all slots are filled, change the battle state to "ready" and start the battle
				if (battle.users.every(u => u !== null)) {
					battle.state = 'ready'
					await startBattle(battle)
				}
			} catch (error) {
				console.error('Error adding bot to battle:', error)
				res.status(500).json({ success: false, message: 'Error adding bot', error: error.message })
			}
		})
	} catch (error) {
		console.error('Error connecting to MongoDB:', error)
	}
}

connectToMongoDB()
