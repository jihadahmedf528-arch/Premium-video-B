const express = require("express");
const admin = require("firebase-admin");
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const DATABASE_URL = process.env.FIREBASE_DATABASE_URL || "";
const WEB_APP_URL = process.env.WEB_APP_URL || "";
const PUBLIC_URL = process.env.PUBLIC_URL || "";
const VIDEO_BOT_USERNAME = process.env.VIDEO_BOT_USERNAME || "";
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || "";

const MONETAG_ZONE_ID = "12187766";
const MIN_REWARDED_AD_MS = 10000;

let db;
let firebaseReady = false;

const DEFAULT_SETTINGS = {
  appName: "Premium Video",
  appLogo: "",
  theme: "dark",
  promotionalChannel: {
    name: "Promotional Channel",
    url: ""
  },
  categories: [
    { id: "all", name: "All Videos", enabled: true },
    { id: "premium", name: "Premium", enabled: true },
    { id: "classic", name: "Classic", enabled: true }
  ],
  reward: {
    enabled: true,
    adsRequired: 50,
    unlockUrl: "",
    unlockMessage: "৫০টি বিজ্ঞাপন সম্পন্ন করে তোমার Reward Unlock করো!"
  },
  referral: {
    enabled: true,
    rewardPerReferral: 1,
    title: "🎁 Referral Program",
    message: "বন্ধুদের সঙ্গে তোমার Referral Link শেয়ার করো। তারা তোমার লিংক দিয়ে প্রথমবার Start করলেই তুমি Credit পাবে।",
    instructions: "১. Referral Link কপি করো।\n২. বন্ধুদের সঙ্গে শেয়ার করো।\n৩. তারা লিংক দিয়ে Start করলেই Credit যোগ হবে।"
  },
  ads: {
    network: "monetag",
    monetagZoneId: MONETAG_ZONE_ID,
    automaticAdsEnabled: true,
    autoFirstAdSeconds: 30,
    autoIntervalSeconds: 90,
    adsPerVideo: 2
  },
  pagination: {
    videosPerPage: 10
  },
  maintenanceMode: false
};

/* Firebase */

function initializeFirebase() {
  if (firebaseReady) return;

  const serviceAccountJSON =
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (!serviceAccountJSON || !DATABASE_URL) {
    console.error("Firebase environment variables missing");
    return;
  }

  try {
    const serviceAccount = JSON.parse(serviceAccountJSON);

    if (serviceAccount.private_key) {
      serviceAccount.private_key =
        serviceAccount.private_key.replace(/\\n/g, "\n");
    }

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: DATABASE_URL
    });

    db = admin.database();
    firebaseReady = true;
    console.log("Firebase connected successfully");
  } catch (error) {
    console.error("Firebase initialization failed:", error.message);
  }
}

initializeFirebase();

function requireFirebase(req, res, next) {
  if (!firebaseReady) {
    return res.status(503).json({
      success: false,
      error: "Firebase not connected"
    });
  }
  next();
}

function safeCompare(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;

  const first = Buffer.from(a);
  const second = Buffer.from(b);

  return first.length === second.length &&
    crypto.timingSafeEqual(first, second);
}

function requireAdmin(req, res, next) {
  const key = req.get("x-admin-key");

  if (!ADMIN_KEY || !safeCompare(key, ADMIN_KEY)) {
    return res.status(401).json({
      success: false,
      error: "Unauthorized"
    });
  }
  next();
}

/* Telegram authentication */

function verifyTelegramInitData(initData) {
  if (!BOT_TOKEN || !initData) return null;

  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) return null;

    params.delete("hash");

    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");

    const secretKey = crypto
      .createHmac("sha256", "WebAppData")
      .update(BOT_TOKEN)
      .digest();

    const calculatedHash = crypto
      .createHmac("sha256", secretKey)
      .update(dataCheckString)
      .digest("hex");

    if (!safeCompare(calculatedHash, hash)) return null;

    const authDate = Number(params.get("auth_date"));

    if (
      !authDate ||
      authDate > Date.now() / 1000 + 60 ||
      Date.now() / 1000 - authDate > 86400
    ) {
      return null;
    }

    return JSON.parse(params.get("user") || "null");
  } catch {
    return null;
  }
}

function requireTelegramUser(req, res, next) {
  const initData = req.get("x-telegram-init-data");
  const user = verifyTelegramInitData(initData);

  if (!user || !user.id) {
    return res.status(401).json({
      success: false,
      error: "Invalid Telegram session"
    });
  }

  req.telegramUser = user;
  next();
}

/* Telegram API */

async function telegramRequest(method, body) {
  if (!BOT_TOKEN) throw new Error("BOT_TOKEN is missing");

  const response = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }
  );

  const result = await response.json();

  if (!response.ok || !result.ok) {
    throw new Error(
      result.description || `Telegram API error (${response.status})`
    );
  }

  return result.result;
}

/* Save Telegram user
   IMPORTANT: Do not write credits/referrals here.
   A profile update must never overwrite a credit transaction. */

async function saveTelegramUser(user, startParam = "") {
  if (!user || !user.id) throw new Error("Invalid Telegram user");

  const userRef = db.ref(`users/${user.id}`);
  const snapshot = await userRef.once("value");
  const oldUser = snapshot.val() || {};
  const isNewUser = !snapshot.exists();

  const savedStartParam =
    String(startParam || "").trim() ||
    String(oldUser.startParam || "").trim();

  await userRef.update({
    telegramId: String(user.id),
    firstName: user.first_name || oldUser.firstName || "",
    lastName: user.last_name || oldUser.lastName || "",
    username: user.username || oldUser.username || "",
    languageCode: user.language_code || oldUser.languageCode || "",
    isPremium: user.is_premium !== undefined
      ? !!user.is_premium
      : !!oldUser.isPremium,
    joinedAt: oldUser.joinedAt || Date.now(),
    lastActive: Date.now(),
    startParam: savedStartParam,
    blocked: false
  });

  return {
    isNewUser,
    startParam: savedStartParam,
    userData: oldUser
  };
}

/* Referral system - retry-safe and duplicate-protected */

async function processReferral(newUserId, startParam = "") {
  const newId = String(newUserId || "").trim();

  if (!/^\d{1,20}$/.test(newId)) {
    return { success: false, reason: "Invalid new user ID" };
  }

  try {
    const claimRef = db.ref(`referralClaims/${newId}`);
    const newUserRef = db.ref(`users/${newId}`);

    let claimSnap = await claimRef.once("value");
    let claim = claimSnap.val() || null;

    let referrerId = "";
    const match = /^ref_(\d{1,20})$/.exec(String(startParam || "").trim());

    if (match) referrerId = match[1];

    if (claim && claim.referrerId) {
      const savedReferrerId = String(claim.referrerId);

      if (referrerId && referrerId !== savedReferrerId) {
        return { success: false, reason: "Referral claim mismatch" };
      }

      referrerId = savedReferrerId;
    }

    if (!referrerId) {
      return { success: false, reason: "No referral" };
    }

    if (referrerId === newId) {
      return { success: false, reason: "Self referral" };
    }

    const newUserSnap = await newUserRef.once("value");
    const newUserData = newUserSnap.val() || {};

    if (
      newUserData.referredBy &&
      String(newUserData.referredBy) !== referrerId
    ) {
      return {
        success: false,
        reason: "User already referred by another person"
      };
    }

    if (claim) {
      if (claim.status === "completed") {
        return { success: false, reason: "Already rewarded" };
      }

      if (String(claim.referrerId) !== referrerId) {
        return { success: false, reason: "Referral claim mismatch" };
      }
    } else {
      if (newUserData.referredBy) {
        return { success: false, reason: "User already referred" };
      }

      const [settingsSnap, referrerSnap] = await Promise.all([
        db.ref("settings/referral").once("value"),
        db.ref(`users/${referrerId}`).once("value")
      ]);

      const referralSettings = {
        ...DEFAULT_SETTINGS.referral,
        ...(settingsSnap.val() || {})
      };

      if (referralSettings.enabled === false) {
        return { success: false, reason: "Referral disabled" };
      }

      if (!referrerSnap.exists()) {
        return { success: false, reason: "Referrer not found" };
      }

      const reward = Number(referralSettings.rewardPerReferral);

      if (
        !Number.isFinite(reward) ||
        reward <= 0 ||
        reward > 1000000
      ) {
        return { success: false, reason: "Invalid referral reward" };
      }

      const claimResult = await claimRef.transaction(current => {
        if (current) return;
        return {
          referrerId,
          newUserId: newId,
          reward,
          status: "pending",
          createdAt: Date.now()
        };
      });

      claim = claimResult.snapshot.val();

      if (!claim || String(claim.referrerId) !== referrerId) {
        return { success: false, reason: "Could not create referral claim" };
      }

      if (claim.status === "completed") {
        return { success: false, reason: "Already rewarded" };
      }
    }

    const reward = Number(claim.reward);

    if (
      !Number.isFinite(reward) ||
      reward <= 0 ||
      reward > 1000000
    ) {
      return { success: false, reason: "Invalid stored reward" };
    }

    const referrerRef = db.ref(`users/${referrerId}`);

    const referrerResult = await referrerRef.transaction(current => {
      if (!current) return;

      current.referrals = current.referrals || {};

      if (current.referrals[newId]) return current;

      current.credits = (Number(current.credits) || 0) + reward;
      current.totalReferrals =
        (Number(current.totalReferrals) || 0) + 1;

      current.referrals[newId] = {
        reward,
        createdAt: Number(claim.createdAt) || Date.now()
      };

      return current;
    });

    const latestReferrerSnap = await referrerRef.once("value");
    const latestReferrer = latestReferrerSnap.val() || {};

    if (
      !latestReferrer.referrals ||
      !latestReferrer.referrals[newId]
    ) {
      return {
        success: false,
        reason: referrerResult.committed
          ? "Could not confirm referral reward"
          : "Referrer not found or transaction failed"
      };
    }

    await newUserRef.transaction(current => {
      if (!current) return;

      if (
        current.referredBy &&
        String(current.referredBy) !== referrerId
      ) {
        return;
      }

      current.referredBy = referrerId;
      current.referredAt =
        Number(claim.createdAt) || Date.now();

      return current;
    });

    const latestNewUserSnap = await newUserRef.once("value");
    const latestNewUser = latestNewUserSnap.val() || {};

    if (String(latestNewUser.referredBy || "") !== referrerId) {
      return {
        success: false,
        reason: "Could not save referral ownership"
      };
    }

    await claimRef.update({
      status: "completed",
      completedAt: Date.now()
    });

    console.log(
      `Referral completed: referrer=${referrerId}, newUser=${newId}, reward=${reward}`
    );

    return {
      success: true,
      reward,
      referrerId,
      newUserId: newId
    };
  } catch (error) {
    console.error("Referral processing error:", error.message);
    return { success: false, reason: error.message };
  }
}

/* Recover pending referral claims */

let referralRecoveryRunning = false;

async function recoverPendingReferralClaims() {
  if (!firebaseReady || referralRecoveryRunning) return;

  referralRecoveryRunning = true;

  try {
    const snapshot = await db.ref("referralClaims").once("value");
    if (!snapshot.exists()) return;

    const claims = snapshot.val() || {};

    for (const [newUserId, claim] of Object.entries(claims)) {
      if (!claim || claim.status !== "pending" || !claim.referrerId) {
        continue;
      }

      const result = await processReferral(
        claim.newUserId || newUserId,
        `ref_${claim.referrerId}`
      );

      if (result.success) {
        console.log(
          `Pending referral recovered: newUser=${newUserId}, reward=${result.reward}`
        );
      } else {
        console.log(
          `Pending referral not recovered: newUser=${newUserId}, reason=${result.reason}`
        );
      }
    }
  } catch (error) {
    console.error("Referral recovery error:", error.message);
  } finally {
    referralRecoveryRunning = false;
  }
}

/* Settings */

function mergeSettings(saved = {}) {
  const savedAds = saved.ads || {};

  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    promotionalChannel: {
      ...DEFAULT_SETTINGS.promotionalChannel,
      ...(saved.promotionalChannel || {})
    },
    reward: {
      ...DEFAULT_SETTINGS.reward,
      ...(saved.reward || {})
    },
    referral: {
      ...DEFAULT_SETTINGS.referral,
      ...(saved.referral || {})
    },
    ads: {
      network: "monetag",
      monetagZoneId: MONETAG_ZONE_ID,
      automaticAdsEnabled: savedAds.automaticAdsEnabled !== false,
      autoFirstAdSeconds: Math.max(
        5,
        Math.min(3600, Number(savedAds.autoFirstAdSeconds) || 30)
      ),
      autoIntervalSeconds: Math.max(
        10,
        Math.min(3600, Number(savedAds.autoIntervalSeconds) || 90)
      ),
      adsPerVideo: Math.max(
        1,
        Math.min(100, Number(savedAds.adsPerVideo) ||
          DEFAULT_SETTINGS.ads.adsPerVideo)
      )
    },
    pagination: {
      ...DEFAULT_SETTINGS.pagination,
      ...(saved.pagination || {})
    }
  };
}

/* Monetag reward progress */

function getRewardProgress(userData = {}) {
  const progress = userData.monetagRewardProgress || {};
  return {
    completed: Math.max(0, Number(progress.completed) || 0),
    events: progress.events || {},
    lastAdAt: Number(progress.lastAdAt) || 0
  };
}

function getRewardStatus(settings, userData = {}) {
  const reward = settings.reward;
  const progress = getRewardProgress(userData);
  const required = Math.max(
    1,
    Math.min(1000, Number(reward.adsRequired) || 50)
  );
  const enabled = reward.enabled === true;
  const unlocked = enabled && !!reward.unlockUrl &&
    progress.completed >= required;

  return {
    success: true,
    enabled,
    completed: progress.completed,
    required,
    unlocked,
    unlockMessage: reward.unlockMessage || "",
    ...(unlocked ? { unlockUrl: reward.unlockUrl } : {})
  };
}

function validYmid(value) {
  return typeof value === "string" &&
    value.length >= 8 &&
    value.length <= 150 &&
    /^[a-zA-Z0-9_-]+$/.test(value);
}

function hashYmid(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/* Health */

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    firebase: firebaseReady,
    app: "Premium Video"
  });
});

/* Public settings */

app.get("/api/settings", requireFirebase, async (req, res) => {
  try {
    const snapshot = await db.ref("settings").once("value");
    const settings = mergeSettings(snapshot.val() || {});
    settings.reward.unlockUrl = "";
    res.json({ success: true, settings });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/* Admin settings */

app.get(
  "/api/admin/settings",
  requireFirebase,
  requireAdmin,
  async (req, res) => {
    try {
      const snapshot = await db.ref("settings").once("value");
      res.json({
        success: true,
        settings: mergeSettings(snapshot.val() || {})
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

/* Public videos */

app.get("/api/videos", requireFirebase, async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const category = String(req.query.category || "all");

    const snapshot = await db.ref("videos")
      .orderByChild("createdAt")
      .once("value");

    let videos = [];

    snapshot.forEach(child => {
      const video = child.val();
      if (video && video.enabled !== false) {
        const { videoUrl, ...publicVideo } = video;
        videos.push({ id: child.key, ...publicVideo });
      }
    });

    videos.reverse();

    if (category !== "all") {
      videos = videos.filter(video => video.categoryId === category);
    }

    const settingsSnap = await db
      .ref("settings/pagination/videosPerPage")
      .once("value");

    const perPage = Math.max(
      1,
      Math.min(50, Number(settingsSnap.val()) ||
        DEFAULT_SETTINGS.pagination.videosPerPage)
    );

    const total = videos.length;
    const totalPages = Math.max(1, Math.ceil(total / perPage));
    const start = (page - 1) * perPage;

    res.json({
      success: true,
      videos: videos.slice(start, start + perPage),
      pagination: {
        page,
        perPage,
        total,
        totalPages,
        hasNext: page < totalPages,
        hasPrevious: page > 1
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/* Video Unlock: count one ad after frontend countdown */

app.post(
  "/api/video/ad/count",
  requireFirebase,
  requireTelegramUser,
  async (req, res) => {
    try {
      const user = req.telegramUser;
      const videoId = String(req.body?.videoId || "").trim();

      if (!/^[a-zA-Z0-9_-]{1,150}$/.test(videoId)) {
        return res.status(400).json({
          success: false,
          error: "Invalid video ID"
        });
      }

      await saveTelegramUser(user);

      const [videoSnap, settingsSnap] = await Promise.all([
        db.ref(`videos/${videoId}`).once("value"),
        db.ref("settings").once("value")
      ]);

      if (!videoSnap.exists() || videoSnap.val()?.enabled === false) {
        return res.status(404).json({
          success: false,
          error: "Video not found"
        });
      }

      const video = videoSnap.val();

      if (!video.videoUrl) {
        return res.status(404).json({
          success: false,
          error: "Video URL not available"
        });
      }

      const settings = mergeSettings(settingsSnap.val() || {});
      const required = Math.max(
        1,
        Math.min(100, Number(video.adsRequired) ||
          settings.ads.adsPerVideo)
      );

      const progressRef = db.ref(
        `users/${user.id}/videoAdProgress/${videoId}`
      );

      const countTime = Date.now();
      let unlockedThisRequest = false;

      const result = await progressRef.transaction(current => {
        current = current || {};
        let completed = Math.max(0, Number(current.completed) || 0);
        completed += 1;
        unlockedThisRequest = false;

        if (completed >= required) {
          unlockedThisRequest = true;
          return {
            completed: 0,
            required,
            totalAdsCompleted:
              (Number(current.totalAdsCompleted) || 0) + required,
            totalUnlocks: (Number(current.totalUnlocks) || 0) + 1,
            lastUnlockAt: countTime,
            lastCountAt: countTime,
            updatedAt: countTime
          };
        }

        return {
          ...current,
          completed,
          required,
          lastCountAt: countTime,
          updatedAt: countTime
        };
      });

      if (!result.committed) {
        return res.status(500).json({
          success: false,
          error: "Could not update video ad progress"
        });
      }

      const updated = result.snapshot.val() || {};

      if (unlockedThisRequest) {
        console.log(`Video unlocked: user=${user.id}, video=${videoId}`);
        return res.json({
          success: true,
          unlocked: true,
          videoId,
          completed: required,
          required,
          remaining: 0,
          videoUrl: video.videoUrl,
          message: "Video unlocked successfully"
        });
      }

      const completed = Number(updated.completed) || 0;
      res.json({
        success: true,
        unlocked: false,
        videoId,
        completed,
        required,
        remaining: Math.max(0, required - completed),
        message: "Ad counted"
      });
    } catch (error) {
      console.error("Video ad count error:", error.message);
      res.status(500).json({
        success: false,
        error: "Could not count video ad"
      });
    }
  }
);

/* Credit balance */

app.get(
  "/api/credits/status",
  requireFirebase,
  requireTelegramUser,
  async (req, res) => {
    try {
      const user = req.telegramUser;
      await saveTelegramUser(user);

      const snapshot = await db.ref(`users/${user.id}/credits`).once("value");
      const credits = Math.max(0, Number(snapshot.val()) || 0);

      res.json({ success: true, credits });
    } catch (error) {
      console.error("Credit status error:", error.message);
      res.status(500).json({
        success: false,
        error: "Could not load credit balance"
      });
    }
  }
);

/* Unlock video with exactly one credit */

app.post(
  "/api/credits/unlock",
  requireFirebase,
  requireTelegramUser,
  async (req, res) => {
    try {
      const user = req.telegramUser;
      const videoId = String(req.body?.videoId || "").trim();

      if (!/^[a-zA-Z0-9_-]{1,150}$/.test(videoId)) {
        return res.status(400).json({
          success: false,
          error: "Invalid video ID"
        });
      }

      await saveTelegramUser(user);

      const videoRef = db.ref(`videos/${videoId}`);
      const videoSnap = await videoRef.once("value");

      if (!videoSnap.exists() || videoSnap.val()?.enabled === false) {
        return res.status(404).json({
          success: false,
          error: "Video not found"
        });
      }

      const video = videoSnap.val();

      if (!video.videoUrl) {
        return res.status(404).json({
          success: false,
          error: "Video URL not available"
        });
      }

      const creditRef = db.ref(`users/${user.id}/credits`);
      const transaction = await creditRef.transaction(current => {
        const balance = Math.max(0, Number(current) || 0);
        if (balance < 1) return;
        return balance - 1;
      });

      if (!transaction.committed) {
        const latestBalance = Math.max(
          0,
          Number(transaction.snapshot.val()) || 0
        );
        return res.status(400).json({
          success: false,
          error: "Not enough credits",
          credits: latestBalance,
          required: 1
        });
      }

      const remainingCredits = Math.max(
        0,
        Number(transaction.snapshot.val()) || 0
      );

      console.log(
        `Credit video unlock: user=${user.id}, video=${videoId}, remaining=${remainingCredits}`
      );

      res.json({
        success: true,
        unlocked: true,
        videoId,
        credits: remainingCredits,
        videoUrl: video.videoUrl,
        message: "Video unlocked with 1 credit"
      });
    } catch (error) {
      console.error("Credit unlock error:", error.message);
      res.status(500).json({
        success: false,
        error: "Could not unlock video with credit"
      });
    }
  }
);

/* Legacy credit unlock endpoint remains disabled */

app.post(
  "/api/video/unlock",
  requireFirebase,
  requireTelegramUser,
  (req, res) => {
    res.status(403).json({
      success: false,
      error: "Use the credits unlock endpoint"
    });
  }
);

/* Current user */

app.get(
  "/api/me",
  requireFirebase,
  requireTelegramUser,
  async (req, res) => {
    try {
      const user = req.telegramUser;
      await saveTelegramUser(user);

      const snapshot = await db.ref(`users/${user.id}`).once("value");
      const data = snapshot.val() || {};

      res.json({
        success: true,
        user: {
          ...data,
          id: String(user.id),
          credits: Number(data.credits) || 0,
          totalReferrals: Number(data.totalReferrals) || 0
        }
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

/* Reward status */

app.get(
  "/api/reward/status",
  requireFirebase,
  requireTelegramUser,
  async (req, res) => {
    try {
      const user = req.telegramUser;
      await saveTelegramUser(user);

      const [settingsSnap, userSnap] = await Promise.all([
        db.ref("settings").once("value"),
        db.ref(`users/${user.id}`).once("value")
      ]);

      const settings = mergeSettings(settingsSnap.val() || {});
      res.json(getRewardStatus(settings, userSnap.val() || {}));
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

/* Count one completed Special Reward ad */

app.post(
  "/api/reward/verify",
  requireFirebase,
  requireTelegramUser,
  async (req, res) => {
    try {
      const user = req.telegramUser;
      const ymid = String(req.body?.ymid || "").trim();

      if (!validYmid(ymid)) {
        return res.status(400).json({
          success: false,
          error: "Invalid ad reference"
        });
      }

      await saveTelegramUser(user);

      const [settingsSnap, userSnap] = await Promise.all([
        db.ref("settings").once("value"),
        db.ref(`users/${user.id}`).once("value")
      ]);

      const settings = mergeSettings(settingsSnap.val() || {});
      const reward = settings.reward;

      if (!reward.enabled) {
        return res.status(403).json({
          success: false,
          error: "Reward system is disabled"
        });
      }

      if (!reward.unlockUrl) {
        return res.status(400).json({
          success: false,
          error: "Reward unlock URL is not configured"
        });
      }

      const ymidHash = hashYmid(ymid);
      const claimRef = db.ref(`monetagRewardClaims/${ymidHash}`);

      const claimResult = await claimRef.transaction(current => {
        if (current) return;
        return {
          userId: String(user.id),
          createdAt: Date.now(),
          status: "claimed"
        };
      });

      const claim = claimResult.snapshot.val();

      if (
        !claimResult.committed ||
        !claim ||
        String(claim.userId) !== String(user.id)
      ) {
        return res.status(409).json({
          success: false,
          error: "This ad reference has already been used"
        });
      }

      const progressRef = db.ref(
        `users/${user.id}/monetagRewardProgress`
      );

      let retryAfterMs = 0;

      const progressResult = await progressRef.transaction(current => {
        const now = Date.now();
        current = current || {};
        current.completed = Math.max(0, Number(current.completed) || 0);
        current.events = current.events || {};

        if (current.events[ymidHash]) return;

        const previousAdAt = Number(current.lastAdAt) || 0;

        if (previousAdAt > 0) {
          const elapsed = now - previousAdAt;
          if (elapsed < MIN_REWARDED_AD_MS) {
            retryAfterMs = MIN_REWARDED_AD_MS - elapsed;
            return;
          }
        }

        current.events[ymidHash] = true;
        current.completed += 1;
        current.lastAdAt = now;
        current.updatedAt = now;
        return current;
      });

      if (!progressResult.committed) {
        await claimRef.remove();

        if (retryAfterMs > 0) {
          return res.status(429).json({
            success: false,
            error: "Please wait before counting the next ad",
            retryAfterMs
          });
        }

        return res.status(500).json({
          success: false,
          error: "Could not update reward progress"
        });
      }

      await claimRef.update({
        status: "credited",
        creditedAt: Date.now()
      });

      const latestUserSnap = await db.ref(`users/${user.id}`).once("value");
      const status = getRewardStatus(settings, latestUserSnap.val() || {});

      console.log(
        `Monetag reward counted: user=${user.id}, completed=${status.completed}`
      );

      res.json({
        ...status,
        verified: true,
        message: status.unlocked ? "Reward unlocked" : "Ad counted"
      });
    } catch (error) {
      console.error("Reward count error:", error.message);
      res.status(500).json({
        success: false,
        error: "Could not count reward ad"
      });
    }
  }
);

/* Admin dashboard */

app.get(
  "/api/admin/dashboard",
  requireFirebase,
  requireAdmin,
  async (req, res) => {
    try {
      const [users, videos] = await Promise.all([
        db.ref("users").once("value"),
        db.ref("videos").once("value")
      ]);

      let totalReferrals = 0;
      let totalCredits = 0;

      users.forEach(child => {
        const user = child.val() || {};
        totalReferrals += Number(user.totalReferrals) || 0;
        totalCredits += Number(user.credits) || 0;
      });

      res.json({
        success: true,
        totalUsers: users.numChildren(),
        totalVideos: videos.numChildren(),
        totalReferrals,
        totalCredits
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

/* Admin update settings */

app.put(
  "/api/admin/settings",
  requireFirebase,
  requireAdmin,
  async (req, res) => {
    try {
      const allowed = [
        "appName",
        "appLogo",
        "theme",
        "promotionalChannel",
        "categories",
        "reward",
        "referral",
        "ads",
        "pagination",
        "maintenanceMode"
      ];

      const updates = {};

      for (const key of allowed) {
        if (req.body[key] !== undefined) updates[key] = req.body[key];
      }

      if (updates.reward) {
        const snap = await db.ref("settings/reward").once("value");
        const current = {
          ...DEFAULT_SETTINGS.reward,
          ...(snap.val() || {})
        };
        const incoming = updates.reward;

        const adsRequired = incoming.adsRequired !== undefined
          ? Number(incoming.adsRequired)
          : Number(current.adsRequired);

        const unlockMessage = incoming.unlockMessage !== undefined
          ? String(incoming.unlockMessage)
          : String(current.unlockMessage || "");

        const unlockUrl = incoming.unlockUrl !== undefined
          ? String(incoming.unlockUrl).trim()
          : String(current.unlockUrl || "");

        if (!Number.isInteger(adsRequired) ||
          adsRequired < 1 || adsRequired > 1000) {
          return res.status(400).json({
            success: false,
            error: "Required ads must be between 1 and 1000"
          });
        }

        if (unlockMessage.length > 500) {
          return res.status(400).json({
            success: false,
            error: "Unlock message maximum is 500 characters"
          });
        }

        if (unlockUrl) {
          try {
            const parsed = new URL(unlockUrl);
            if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
              throw new Error("Invalid protocol");
            }
          } catch {
            return res.status(400).json({
              success: false,
              error: "Reward URL must be a valid HTTP or HTTPS URL"
            });
          }
        }

        updates.reward = {
          ...current,
          ...incoming,
          enabled: incoming.enabled !== undefined
            ? !!incoming.enabled
            : !!current.enabled,
          adsRequired,
          unlockUrl,
          unlockMessage
        };
      }

      if (updates.referral) {
        const snap = await db.ref("settings/referral").once("value");
        const current = {
          ...DEFAULT_SETTINGS.referral,
          ...(snap.val() || {})
        };
        const incoming = updates.referral;

        const reward = incoming.rewardPerReferral !== undefined
          ? Number(incoming.rewardPerReferral)
          : Number(current.rewardPerReferral);

        const title = incoming.title !== undefined
          ? String(incoming.title)
          : String(current.title || "");

        const message = incoming.message !== undefined
          ? String(incoming.message)
          : String(current.message || "");

        const instructions = incoming.instructions !== undefined
          ? String(incoming.instructions)
          : String(current.instructions || "");

        if (!Number.isFinite(reward) || reward < 0 || reward > 1000000) {
          return res.status(400).json({
            success: false,
            error: "Referral reward must be between 0 and 1000000"
          });
        }

        if (title.length > 150 || message.length > 2000 ||
          instructions.length > 2000) {
          return res.status(400).json({
            success: false,
            error: "Referral text is too long"
          });
        }

        updates.referral = {
          ...current,
          ...incoming,
          enabled: incoming.enabled !== undefined
            ? !!incoming.enabled
            : !!current.enabled,
          rewardPerReferral: reward,
          title,
          message,
          instructions
        };
      }

      if (updates.ads) {
        const snap = await db.ref("settings/ads").once("value");
        const current = {
          ...DEFAULT_SETTINGS.ads,
          ...(snap.val() || {})
        };
        const incoming = updates.ads;

        const adsPerVideo = incoming.adsPerVideo !== undefined
          ? Number(incoming.adsPerVideo)
          : Number(current.adsPerVideo) || 2;

        const autoFirstAdSeconds =
          incoming.autoFirstAdSeconds !== undefined
            ? Number(incoming.autoFirstAdSeconds)
            : Number(current.autoFirstAdSeconds) || 30;

        const autoIntervalSeconds =
          incoming.autoIntervalSeconds !== undefined
            ? Number(incoming.autoIntervalSeconds)
            : Number(current.autoIntervalSeconds) || 90;

        if (!Number.isInteger(adsPerVideo) ||
          adsPerVideo < 1 || adsPerVideo > 100) {
          return res.status(400).json({
            success: false,
            error: "Ads per video must be between 1 and 100"
          });
        }

        if (!Number.isInteger(autoFirstAdSeconds) ||
          autoFirstAdSeconds < 5 || autoFirstAdSeconds > 3600) {
          return res.status(400).json({
            success: false,
            error: "First automatic ad delay must be 5-3600 seconds"
          });
        }

        if (!Number.isInteger(autoIntervalSeconds) ||
          autoIntervalSeconds < 10 || autoIntervalSeconds > 3600) {
          return res.status(400).json({
            success: false,
            error: "Automatic ad interval must be 10-3600 seconds"
          });
        }

        updates.ads = {
          network: "monetag",
          monetagZoneId: MONETAG_ZONE_ID,
          automaticAdsEnabled:
            incoming.automaticAdsEnabled !== undefined
              ? incoming.automaticAdsEnabled === true ||
                incoming.automaticAdsEnabled === "true"
              : current.automaticAdsEnabled !== false,
          autoFirstAdSeconds,
          autoIntervalSeconds,
          adsPerVideo
        };
      }

      await db.ref("settings").update(updates);
      res.json({ success: true, message: "Settings updated" });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

/* Admin video list */

app.get(
  "/api/admin/videos",
  requireFirebase,
  requireAdmin,
  async (req, res) => {
    try {
      const snapshot = await db.ref("videos")
        .orderByChild("createdAt")
        .once("value");

      const videos = [];
      snapshot.forEach(child => {
        const video = child.val();
        if (video) videos.push({ id: child.key, ...video });
      });

      videos.reverse();
      res.json({ success: true, videos });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

/* Notify users about new video with thumbnail */

async function notifyAllUsers(video) {
  const snapshot = await db.ref("users").once("value");
  const users = snapshot.val() || {};
  const botUsername = VIDEO_BOT_USERNAME.replace(/^@/, "");

  const deepLink = botUsername
    ? `https://t.me/${botUsername}?start=v_${video.id}`
    : WEB_APP_URL;

  const title = String(video.title || "নতুন ভিডিও").slice(0, 200);
  const description = String(video.description || "").slice(0, 700);

  const caption =
    `🎬 ${title}\n\n` +
    (description ? `${description}\n\n` : "") +
    `📺 Premium Video-তে দেখতে নিচের বাটনে ক্লিক করো।`;

  const ids = Object.keys(users);

  for (let i = 0; i < ids.length; i += 20) {
    const batch = ids.slice(i, i + 20);

    await Promise.allSettled(batch.map(async id => {
      try {
        const keyboard = deepLink
          ? {
              inline_keyboard: [[
                { text: "▶️ ভিডিও দেখুন", url: deepLink }
              ]]
            }
          : undefined;

        if (video.thumbnail) {
          try {
            await telegramRequest("sendPhoto", {
              chat_id: id,
              photo: video.thumbnail,
              caption,
              reply_markup: keyboard
            });
            return;
          } catch (photoError) {
            console.error(
              `Thumbnail notification failed for ${id}:`,
              photoError.message
            );
          }
        }

        await telegramRequest("sendMessage", {
          chat_id: id,
          text: caption,
          reply_markup: keyboard,
          disable_web_page_preview: false
        });
      } catch (error) {
        if (/blocked|chat not found|deactivated/i.test(error.message)) {
          await db.ref(`users/${id}`).update({ blocked: true });
        } else {
          console.error(`Notification failed for ${id}:`, error.message);
        }
      }
    }));
  }

  return ids.length;
}

/* Admin add video */

app.post(
  "/api/admin/videos",
  requireFirebase,
  requireAdmin,
  async (req, res) => {
    try {
      const {
        title,
        description,
        thumbnail,
        videoUrl,
        categoryId,
        adsRequired
      } = req.body;

      if (!title || !thumbnail || !videoUrl) {
        return res.status(400).json({
          success: false,
          error: "Title, thumbnail and video URL are required"
        });
      }

      const required = Number(adsRequired);

      if (!Number.isInteger(required) || required < 1 || required > 100) {
        return res.status(400).json({
          success: false,
          error: "Ads Required must be between 1 and 100"
        });
      }

      const videoRef = db.ref("videos").push();

      const video = {
        title: String(title).slice(0, 200),
        description: String(description || "").slice(0, 2000),
        thumbnail: String(thumbnail),
        videoUrl: String(videoUrl),
        categoryId: String(categoryId || "premium"),
        adsRequired: required,
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };

      await videoRef.set(video);

      let notifiedUsers = 0;
      try {
        notifiedUsers = await notifyAllUsers({
          id: videoRef.key,
          ...video
        });
      } catch (error) {
        console.error("Notification error:", error.message);
      }

      res.json({
        success: true,
        videoId: videoRef.key,
        notifiedUsers,
        message: "Video added"
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

/* Admin edit video */

app.put(
  "/api/admin/videos/:id",
  requireFirebase,
  requireAdmin,
  async (req, res) => {
    try {
      const ref = db.ref(`videos/${req.params.id}`);
      const snapshot = await ref.once("value");

      if (!snapshot.exists()) {
        return res.status(404).json({
          success: false,
          error: "Video not found"
        });
      }

      const allowed = [
        "title",
        "description",
        "thumbnail",
        "videoUrl",
        "categoryId",
        "adsRequired",
        "enabled"
      ];

      const updates = { updatedAt: Date.now() };

      for (const key of allowed) {
        if (req.body[key] !== undefined) updates[key] = req.body[key];
      }

      if (updates.adsRequired !== undefined) {
        const required = Number(updates.adsRequired);

        if (!Number.isInteger(required) || required < 1 || required > 100) {
          return res.status(400).json({
            success: false,
            error: "Ads Required must be between 1 and 100"
          });
        }
        updates.adsRequired = required;
      }

      await ref.update(updates);
      res.json({ success: true, message: "Video updated" });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

/* Admin delete video */

app.delete(
  "/api/admin/videos/:id",
  requireFirebase,
  requireAdmin,
  async (req, res) => {
    try {
      await db.ref(`videos/${req.params.id}`).remove();
      res.json({ success: true, message: "Video deleted" });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

/* Admin broadcast */

app.post(
  "/api/admin/broadcast",
  requireFirebase,
  requireAdmin,
  async (req, res) => {
    try {
      const message = String(req.body.message || "").trim();

      if (!message || message.length > 4000) {
        return res.status(400).json({
          success: false,
          error: "Message is required (maximum 4000 characters)"
        });
      }

      const snapshot = await db.ref("users").once("value");
      const users = snapshot.val() || {};
      const ids = Object.keys(users);

      let sent = 0;
      let failed = 0;

      for (let i = 0; i < ids.length; i += 20) {
        const batch = ids.slice(i, i + 20);
        const results = await Promise.allSettled(
          batch.map(id => telegramRequest("sendMessage", {
            chat_id: id,
            text: message,
            disable_web_page_preview: false
          }))
        );

        results.forEach(result => {
          if (result.status === "fulfilled") sent++;
          else failed++;
        });
      }

      res.json({ success: true, total: ids.length, sent, failed });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

/* Telegram webhook */

app.post("/api/telegram/webhook", async (req, res) => {
  if (
    WEBHOOK_SECRET &&
    req.get("x-telegram-bot-api-secret-token") !== WEBHOOK_SECRET
  ) {
    return res.sendStatus(403);
  }

  res.sendStatus(200);

  try {
    const message = req.body.message;

    if (!message || !message.from || !message.chat || !firebaseReady) {
      return;
    }

    const text = message.text || "";

    if (text.startsWith("/start")) {
      const payload = text.split(/\s+/)[1] || "";

      const savedUser = await saveTelegramUser(message.from, payload);

      const referralParam = payload || savedUser.startParam || "";
      const referralResult = await processReferral(
        message.from.id,
        referralParam
      );

      if (referralResult.success) {
        await telegramRequest("sendMessage", {
          chat_id: message.chat.id,
          text:
            `🎉 অভিনন্দন!\n\n` +
            `তোমার Referral থেকে ${referralResult.reward} Credit যোগ হয়েছে।`
        });
      } else if (
        referralParam.startsWith("ref_") &&
        referralResult.reason !== "Already rewarded"
      ) {
        console.log(
          `Referral not completed: newUser=${message.from.id}, reason=${referralResult.reason}`
        );
      }

      const botUsername = VIDEO_BOT_USERNAME.replace(/^@/, "");
      const referralLink = botUsername
        ? `https://t.me/${botUsername}?start=ref_${message.from.id}`
        : "";

      const keyboard = WEB_APP_URL
        ? {
            inline_keyboard: [[
              {
                text: "🎬 Open Premium Video",
                web_app: { url: WEB_APP_URL }
              }
            ]]
          }
        : undefined;

      let welcomeText =
        "স্বাগতম Premium Video-তে! নিচের বাটনে Mini App খুলুন।";

      if (referralLink) {
        welcomeText += `\n\n🔗 তোমার Referral Link:\n${referralLink}`;
      }

      await telegramRequest("sendMessage", {
        chat_id: message.chat.id,
        text: welcomeText,
        reply_markup: keyboard
      });
    }
  } catch (error) {
    console.error("Webhook processing error:", error.message);
  }
});

/* Setup Telegram webhook */

async function setupWebhook() {
  if (!BOT_TOKEN || !PUBLIC_URL || !WEBHOOK_SECRET) {
    console.log("Webhook setup skipped: environment variables missing");
    return;
  }

  try {
    const url = `${PUBLIC_URL.replace(/\/$/, "")}/api/telegram/webhook`;

    await telegramRequest("setWebhook", {
      url,
      secret_token: WEBHOOK_SECRET,
      allowed_updates: ["message"]
    });

    console.log("Telegram webhook configured");
  } catch (error) {
    console.error("Webhook setup failed:", error.message);
  }
}

/* Home route */

app.get("/", (req, res) => {
  res.send("Premium Video Backend is running");
});

/* Start server */

app.listen(PORT, () => {
  console.log(`Premium Video server running on port ${PORT}`);

  setupWebhook();

  setTimeout(() => {
    recoverPendingReferralClaims();
  }, 5000);

  setInterval(() => {
    recoverPendingReferralClaims();
  }, 60000);
});
