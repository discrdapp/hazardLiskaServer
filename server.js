const express = require('express')
const cors = require('cors')
const { WebSocketServer, WebSocket} = require('ws')
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
					bets.push({ userId: user._id, color, amount, username: user.username, pfp: user.profileImage, level: user.level, exp: user.exp })
				}

				await usersCollection.updateOne({ _id: user._id }, { $inc: { balance: -amount } })

				const updatedUser = await addExp(user._id, amount)

				// Sort bets
				const sortedBets = bets.sort((a, b) => b.amount - a.amount)

				// Single broadcast message
				sendMessageToUsers([user._id.toString()], {
					type: 'updateBalance',
					newBalance: user.balance - amount,
					level: updatedUser.level,
					exp: updatedUser.exp,
				})

				//broadcast to all connected clients
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

		async function processBets(winningColor) {
			winningBets = []

			for (const bet of bets) {
				const user = await usersCollection.findOne({ _id: new ObjectId(bet.userId) })

				if (bet.color === winningColor) {
					const payoutMultiplier = bet.color === 'green' ? 14 : 2
					const payout = bet.amount * payoutMultiplier

					await usersCollection.updateOne({ _id: user._id }, { $inc: { balance: payout } })

					// Prepare the winning bet object to broadcast
					winningBets.push({ userId: user._id, balance: user.balance + payout })

					sendMessageToUsers([user._id.toString()], {
						type: 'updateBalance',
						newBalance: user.balance + payout,
					})
				}
			}
		}

		// Function to fetch skins from MongoDB with pagination, filtering, and sorting
		async function fetchSkinsFromDB(collection, query, skip, limit, sortOrder) {
			try {
				console.log(query, skip, limit, sortOrder)
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
			const casesCollection = db.collection('cases')

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
			const casesCollection = db.collection('cases')
			try {
				const cases = await casesCollection.find({}).toArray()
				res.status(200).json(cases)
			} catch (error) {
				res.status(500).json({ success: false, message: 'Error fetching cases', error: error.message })
			}
		})

		app.get('/cases/:caseId', async (req, res) => {
			const { caseId } = req.params
			const casesCollection = db.collection('cases')
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
			const casesCollection = db.collection('cases')
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
					action: 'Sold a skin',
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
					action: 'Sold multiple skins',
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
				console.log(query, skip, limit)
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
	} catch (error) {
		console.error('Error connecting to MongoDB:', error)
	}
}

connectToMongoDB()
