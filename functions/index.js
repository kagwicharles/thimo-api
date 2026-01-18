const functions = require('firebase-functions');
const admin = require('firebase-admin');
const express = require('express');
const cors = require('cors');

// Initialize Firebase Admin
admin.initializeApp();
const db = admin.database();

// Create Express app
const app = express();

// Middleware
app.use(cors({ origin: true })); // Allow all origins (configure for production)
app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Thimo API is running',
    timestamp: new Date().toISOString()
  });
});

// Get user data
app.get('/api/user/:userId', async (req, res) => {
  const { userId } = req.params;
  
  if (!userId) {
    return res.status(400).json({ error: 'Missing userId' });
  }
  
  try {
    const userRef = db.ref(`users/${userId}`);
    const snapshot = await userRef.once('value');
    
    if (!snapshot.exists()) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userData = snapshot.val();
    
    res.json({
      userId: userId,
      email: userData.email || '',
      name: userData.name || '',
      isPremium: userData.isPremium || false,
      lastSubscriptionDate: userData.lastSubscriptionDate || '',
      mpesaRef: userData.mpesaRef || ''
    });
    
  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({ error: 'Failed to fetch user data' });
  }
});

// Initiate M-Pesa payment
app.post('/api/initiate-payment', async (req, res) => {
  const { userId, amount, billingCycle, phoneNumber } = req.body;
  
  if (!userId || !amount || !phoneNumber) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  
  try {
    // Verify user exists
    const userRef = db.ref(`users/${userId}`);
    const userSnapshot = await userRef.once('value');
    
    if (!userSnapshot.exists()) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Create payment record
    const paymentRef = db.ref('payments').push();
    await paymentRef.set({
      userId,
      amount,
      billingCycle,
      phoneNumber,
      status: 'pending',
      createdAt: admin.database.ServerValue.TIMESTAMP
    });

    // TODO: Integrate M-Pesa STK Push
    // Get M-Pesa config from Firebase environment
    const mpesaConfig = functions.config().mpesa;
    
    // For now, return success for testing
    res.json({
      success: true,
      paymentId: paymentRef.key,
      message: 'Payment initiated. Please complete on your phone.'
    });
    
  } catch (error) {
    console.error('Payment error:', error);
    res.status(500).json({ error: 'Payment initiation failed' });
  }
});

// M-Pesa callback endpoint
app.post('/api/mpesa-callback', async (req, res) => {
  try {
    const { Body } = req.body;
    const resultCode = Body?.stkCallback?.ResultCode;
    
    if (resultCode === 0) {
      // Payment successful
      const checkoutRequestID = Body.stkCallback.CheckoutRequestID;
      
      // Find payment by checkoutRequestID and update user
      // This is a simplified version - implement based on your needs
      
      console.log('Payment successful:', checkoutRequestID);
      
      // Example: Update user premium status
      // const userId = "..."; // Get from payment record
      // await db.ref(`users/${userId}`).update({
      //   isPremium: true,
      //   lastSubscriptionDate: admin.database.ServerValue.TIMESTAMP,
      //   mpesaRef: checkoutRequestID
      // });
    }

    res.json({ ResultCode: 0, ResultDesc: 'Success' });
  } catch (error) {
    console.error('Callback error:', error);
    res.status(500).json({ error: 'Callback processing failed' });
  }
});

// Verify subscription
app.get('/api/verify-subscription/:userId', async (req, res) => {
  const { userId } = req.params;
  
  try {
    const userRef = db.ref(`users/${userId}`);
    const snapshot = await userRef.once('value');
    
    if (!snapshot.exists()) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userData = snapshot.val();
    
    res.json({
      isPremium: userData.isPremium || false,
      lastSubscriptionDate: userData.lastSubscriptionDate || null
    });
  } catch (error) {
    console.error('Verification error:', error);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// Export the Express app as a Firebase Cloud Function
exports.api = functions.https.onRequest(app);

// Optional: Scheduled function to check subscription expiry
exports.checkSubscriptionExpiry = functions.pubsub
  .schedule('every 24 hours')
  .onRun(async (context) => {
    try {
      const usersRef = db.ref('users');
      const snapshot = await usersRef.once('value');
      const users = snapshot.val();
      
      const now = Date.now();
      const oneMonthMs = 30 * 24 * 60 * 60 * 1000;
      
      for (const userId in users) {
        const user = users[userId];
        if (user.isPremium && user.lastSubscriptionDate) {
          const subscriptionAge = now - user.lastSubscriptionDate;
          
          // Check if subscription expired (30 days for monthly)
          if (subscriptionAge > oneMonthMs) {
            await db.ref(`users/${userId}`).update({
              isPremium: false
            });
            console.log(`Subscription expired for user: ${userId}`);
          }
        }
      }
      
      return null;
    } catch (error) {
      console.error('Error checking subscriptions:', error);
      return null;
    }
  });