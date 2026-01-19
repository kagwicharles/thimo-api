const functions = require("firebase-functions");
const admin = require("firebase-admin");
const express = require("express");
const cors = require("cors");
const axios = require("axios");

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

// M-Pesa Configuration
// Store these in Firebase Functions config or environment variables
const MPESA_CONFIG = {
  // Sandbox credentials - Replace with production when ready
  consumerKey: functions.config().mpesa?.consumer_key || "YOUR_CONSUMER_KEY",
  consumerSecret:
    functions.config().mpesa?.consumer_secret || "YOUR_CONSUMER_SECRET",
  businessShortCode: functions.config().mpesa?.shortcode || "174379", // Sandbox default
  passKey:
    functions.config().mpesa?.passkey ||
    "bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919", // Sandbox default

  // URLs - Use sandbox for testing, production for live
  environment: functions.config().mpesa?.environment || "sandbox", // or "production"

  get authUrl() {
    return this.environment === "sandbox"
      ? "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials"
      : "https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials";
  },

  get stkPushUrl() {
    return this.environment === "sandbox"
      ? "https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest"
      : "https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest";
  },

  get queryUrl() {
    return this.environment === "sandbox"
      ? "https://sandbox.safaricom.co.ke/mpesa/stkpushquery/v1/query"
      : "https://api.safaricom.co.ke/mpesa/stkpushquery/v1/query";
  },
};

// Helper function to generate timestamp (YYYYMMDDHHmmss)
function generateTimestamp() {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${year}${month}${day}${hours}${minutes}${seconds}`;
}

// Helper function to generate password
function generatePassword(timestamp) {
  const { businessShortCode, passKey } = MPESA_CONFIG;
  const password = `${businessShortCode}${passKey}${timestamp}`;
  return Buffer.from(password).toString("base64");
}

// Helper function to get M-Pesa access token
async function getAccessToken() {
  try {
    const { consumerKey, consumerSecret, authUrl } = MPESA_CONFIG;
    const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString(
      "base64",
    );

    const response = await axios.get(authUrl, {
      headers: {
        Authorization: `Basic ${auth}`,
      },
    });

    return response.data.access_token;
  } catch (error) {
    console.error(
      "Error getting access token:",
      error.response?.data || error.message,
    );
    throw new Error("Failed to get M-Pesa access token");
  }
}

// Format phone number to required format (254XXXXXXXXX)
function formatPhoneNumber(phone) {
  // Remove any spaces, dashes, or plus signs
  let cleaned = phone.replace(/[\s\-+]/g, "");

  // If it starts with 0, replace with 254
  if (cleaned.startsWith("0")) {
    cleaned = "254" + cleaned.substring(1);
  }

  // If it doesn't start with 254, add it
  if (!cleaned.startsWith("254")) {
    cleaned = "254" + cleaned;
  }

  return cleaned;
}

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

// Initiate M-Pesa STK Push payment
app.post("/initiate-payment", async (req, res) => {
  console.log("Payment initiation request received");
  const { userId, amount, billingCycle, phoneNumber } = req.body;

  if (!userId || !amount || !phoneNumber) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    // Verify user exists
    const userRef = db.ref(`users/${userId}`);
    const userSnapshot = await userRef.once("value");

    if (!userSnapshot.exists()) {
      return res.status(404).json({ error: "User not found" });
    }

    // Format phone number
    const formattedPhone = formatPhoneNumber(phoneNumber);

    // Validate phone number format
    if (!/^254\d{9}$/.test(formattedPhone)) {
      return res.status(400).json({
        error:
          "Invalid phone number format. Use format: 0712345678 or 254712345678",
      });
    }

    // Get M-Pesa access token
    const accessToken = await getAccessToken();

    // Generate timestamp and password
    const timestamp = generateTimestamp();
    const password = generatePassword(timestamp);

    // Create payment record in database
    const paymentRef = db.ref("payments").push();
    const paymentId = paymentRef.key;

    // Get your deployed Cloud Function URL for the callback
    const callbackUrl = `https://us-central1-dailywisdom-1a00f.cloudfunctions.net/api/mpesa-callback`;

    // Prepare STK Push request
    const stkPushData = {
      BusinessShortCode: MPESA_CONFIG.businessShortCode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline",
      Amount: Math.round(amount), // M-Pesa requires integer amount
      PartyA: formattedPhone, // Customer phone number
      PartyB: MPESA_CONFIG.businessShortCode, // Your paybill/till number
      PhoneNumber: formattedPhone, // Phone number to receive the STK push
      CallBackURL: callbackUrl,
      AccountReference: `THIMO-${paymentId}`, // Unique reference for this transaction
      TransactionDesc: `Thimo ${billingCycle} Subscription`, // Description shown to customer
    };

    console.log("Initiating STK Push:", {
      phone: formattedPhone,
      amount,
      reference: stkPushData.AccountReference,
    });

    // Send STK Push request to M-Pesa
    const stkResponse = await axios.post(MPESA_CONFIG.stkPushUrl, stkPushData, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    });

    console.log("STK Push response:", stkResponse.data);

    // Save payment record with M-Pesa response
    await paymentRef.set({
      userId,
      amount,
      billingCycle,
      phoneNumber: formattedPhone,
      status: "pending",
      merchantRequestID: stkResponse.data.MerchantRequestID,
      checkoutRequestID: stkResponse.data.CheckoutRequestID,
      responseCode: stkResponse.data.ResponseCode,
      responseDescription: stkResponse.data.ResponseDescription,
      customerMessage: stkResponse.data.CustomerMessage,
      createdAt: admin.database.ServerValue.TIMESTAMP,
    });

    // Return success response
    res.json({
      success: true,
      paymentId: paymentId,
      checkoutRequestID: stkResponse.data.CheckoutRequestID,
      message:
        stkResponse.data.CustomerMessage ||
        "Payment initiated. Please complete on your phone.",
    });
  } catch (error) {
    console.error(
      "Payment initiation error:",
      error.response?.data || error.message,
    );

    res.status(500).json({
      error: "Payment initiation failed",
      details: error.response?.data?.errorMessage || error.message,
    });
  }
});

// M-Pesa callback endpoint
app.post("/mpesa-callback", async (req, res) => {
  console.log("M-Pesa callback received");
  console.log("Callback body:", JSON.stringify(req.body, null, 2));

  try {
    const { Body } = req.body;

    if (!Body || !Body.stkCallback) {
      console.error("Invalid callback format");
      return res.json({ ResultCode: 1, ResultDesc: "Invalid callback format" });
    }

    const { stkCallback } = Body;
    const {
      MerchantRequestID,
      CheckoutRequestID,
      ResultCode,
      ResultDesc,
      CallbackMetadata,
    } = stkCallback;

    // Find the payment record
    const paymentsRef = db.ref("payments");
    const snapshot = await paymentsRef
      .orderByChild("checkoutRequestID")
      .equalTo(CheckoutRequestID)
      .once("value");

    if (!snapshot.exists()) {
      console.error("Payment record not found for:", CheckoutRequestID);
      return res.json({
        ResultCode: 1,
        ResultDesc: "Payment record not found",
      });
    }

    const paymentId = Object.keys(snapshot.val())[0];
    const payment = snapshot.val()[paymentId];

    if (ResultCode === 0) {
      // Payment successful
      console.log("Payment successful:", CheckoutRequestID);

      // Extract metadata
      const metadata = {};
      if (CallbackMetadata && CallbackMetadata.Item) {
        CallbackMetadata.Item.forEach((item) => {
          metadata[item.Name] = item.Value;
        });
      }

      // Update payment record
      await db.ref(`payments/${paymentId}`).update({
        status: "completed",
        resultCode: ResultCode,
        resultDesc: ResultDesc,
        amount: metadata.Amount,
        mpesaReceiptNumber: metadata.MpesaReceiptNumber,
        transactionDate: metadata.TransactionDate,
        phoneNumber: metadata.PhoneNumber,
        updatedAt: admin.database.ServerValue.TIMESTAMP,
      });

      // Update user premium status
      const subscriptionEndDate = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days from now

      await db.ref(`users/${payment.userId}`).update({
        isPremium: true,
        lastSubscriptionDate: Date.now(),
        subscriptionEndDate: subscriptionEndDate,
        mpesaRef: metadata.MpesaReceiptNumber,
      });

      console.log(`User ${payment.userId} upgraded to premium`);
    } else {
      // Payment failed
      console.log("Payment failed with code:", ResultCode, ResultDesc);

      await db.ref(`payments/${paymentId}`).update({
        status: "failed",
        resultCode: ResultCode,
        resultDesc: ResultDesc,
        updatedAt: admin.database.ServerValue.TIMESTAMP,
      });
    }

    // Always return success to M-Pesa to acknowledge receipt
    res.json({ ResultCode: 0, ResultDesc: "Success" });
  } catch (error) {
    console.error("Callback processing error:", error);
    res.status(500).json({
      ResultCode: 1,
      ResultDesc: "Internal server error",
    });
  }
});

// Query STK Push status (optional - for checking payment status manually)
app.get("/query-payment/:checkoutRequestID", async (req, res) => {
  const { checkoutRequestID } = req.params;

  try {
    const accessToken = await getAccessToken();
    const timestamp = generateTimestamp();
    const password = generatePassword(timestamp);

    const queryData = {
      BusinessShortCode: MPESA_CONFIG.businessShortCode,
      Password: password,
      Timestamp: timestamp,
      CheckoutRequestID: checkoutRequestID,
    };

    const queryResponse = await axios.post(MPESA_CONFIG.queryUrl, queryData, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    });

    res.json(queryResponse.data);
  } catch (error) {
    console.error("Query error:", error.response?.data || error.message);
    res.status(500).json({
      error: "Query failed",
      details: error.response?.data || error.message,
    });
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
      subscriptionEndDate: userData.subscriptionEndDate || null,
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
      "GET /query-payment/:checkoutRequestID",
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

      for (const userId in users) {
        const user = users[userId];
        if (user.isPremium && user.subscriptionEndDate) {
          if (now > user.subscriptionEndDate) {
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
