const functions = require("firebase-functions");
const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");

// Initialize Firebase Admin
admin.initializeApp();
const db = admin.database();

// Create Express app
const app = express();

// Middleware
app.use(cors({ origin: true }));
app.use(express.json());

// Debug logging middleware
app.use((req, res, next) => {
  console.log("=== Incoming Request ===");
  console.log("Method:", req.method);
  console.log("Path:", req.path);
  console.log("Params:", req.params);
  console.log("========================");
  next();
});

// Health check
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "Thimo API is running",
    timestamp: new Date().toISOString(),
  });
});

// Get user data
app.get("/user/:userId", async (req, res) => {
  const { userId } = req.params;

  console.log("Fetching user:", userId);

  if (!userId) {
    return res.status(400).json({ error: "Missing userId" });
  }

  try {
    const userRef = db.ref(`users/${userId}`);
    const snapshot = await userRef.once("value");

    if (!snapshot.exists()) {
      return res.status(404).json({
        error: "User not found",
        userId: userId,
      });
    }

    const userData = snapshot.val();

    res.json({
      userId: userId,
      email: userData.email || "",
      name: userData.name || "",
      isPremium: userData.isPremium || false,
      lastSubscriptionDate: userData.lastSubscriptionDate || "",
      mpesaRef: userData.mpesaRef || "",
    });
  } catch (error) {
    console.error("Error fetching user:", error);
    res.status(500).json({
      error: "Failed to fetch user data",
      details: error.message,
    });
  }
});

// Initiate M-Pesa payment
app.post("/initiate-payment", async (req, res) => {
  console.log("Payment initiation request received");
  const { userId, amount, billingCycle, phoneNumber } = req.body;

  if (!userId || !amount || !phoneNumber) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    const userRef = db.ref(`users/${userId}`);
    const userSnapshot = await userRef.once("value");

    if (!userSnapshot.exists()) {
      return res.status(404).json({ error: "User not found" });
    }

    const paymentRef = db.ref("payments").push();
    await paymentRef.set({
      userId,
      amount,
      billingCycle,
      phoneNumber,
      status: "pending",
      createdAt: admin.database.ServerValue.TIMESTAMP,
    });

    console.log("Payment record created:", paymentRef.key);

    // TODO: Integrate M-Pesa STK Push
    res.json({
      success: true,
      paymentId: paymentRef.key,
      message: "Payment initiated. Please complete on your phone.",
    });
  } catch (error) {
    console.error("Payment error:", error);
    res.status(500).json({ error: "Payment initiation failed" });
  }
});

// M-Pesa callback endpoint
app.post("/mpesa-callback", async (req, res) => {
  console.log("M-Pesa callback received");
  console.log("Callback body:", JSON.stringify(req.body));

  try {
    const { Body } = req.body;
    const resultCode = Body?.stkCallback?.ResultCode;

    if (resultCode === 0) {
      const checkoutRequestID = Body.stkCallback.CheckoutRequestID;
      console.log("Payment successful:", checkoutRequestID);

      // TODO: Update user premium status based on payment record
    } else {
      console.log("Payment failed with code:", resultCode);
    }

    res.json({ ResultCode: 0, ResultDesc: "Success" });
  } catch (error) {
    console.error("Callback error:", error);
    res.status(500).json({ error: "Callback processing failed" });
  }
});

// Verify subscription
app.get("/verify-subscription/:userId", async (req, res) => {
  const { userId } = req.params;

  try {
    const userRef = db.ref(`users/${userId}`);
    const snapshot = await userRef.once("value");

    if (!snapshot.exists()) {
      return res.status(404).json({ error: "User not found" });
    }

    const userData = snapshot.val();

    res.json({
      isPremium: userData.isPremium || false,
      lastSubscriptionDate: userData.lastSubscriptionDate || null,
    });
  } catch (error) {
    console.error("Verification error:", error);
    res.status(500).json({ error: "Verification failed" });
  }
});

// 404 handler
app.use((req, res) => {
  console.log("404 NOT FOUND - Path:", req.path);
  res.status(404).json({
    error: "Not Found",
    message: "The requested endpoint does not exist",
    path: req.path,
    availableEndpoints: [
      "GET /",
      "GET /user/:userId",
      "POST /initiate-payment",
      "POST /mpesa-callback",
      "GET /verify-subscription/:userId",
    ],
  });
});

// Export as Firebase Cloud Function
exports.api = functions.https.onRequest(app);

// Scheduled function to check subscription expiry
exports.checkSubscriptionExpiry = functions.pubsub
  .schedule("every 24 hours")
  .onRun(async (context) => {
    console.log("Running subscription expiry check");
    try {
      const usersRef = db.ref("users");
      const snapshot = await usersRef.once("value");
      const users = snapshot.val();

      if (!users) {
        console.log("No users found");
        return null;
      }

      const now = Date.now();
      const oneMonthMs = 30 * 24 * 60 * 60 * 1000;

      for (const userId in users) {
        const user = users[userId];
        if (user.isPremium && user.lastSubscriptionDate) {
          const subscriptionAge = now - user.lastSubscriptionDate;

          if (subscriptionAge > oneMonthMs) {
            await db.ref(`users/${userId}`).update({
              isPremium: false,
            });
            console.log(`Subscription expired for user: ${userId}`);
          }
        }
      }

      console.log("Subscription expiry check completed");
      return null;
    } catch (error) {
      console.error("Error checking subscriptions:", error);
      return null;
    }
  });
