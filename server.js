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
const VIDEO_BOT_USERNAME = process.env.VIDEO_BOT_USERNAME || "";

const MONETAG_ZONE_ID = "11846657";
const MIN_REWARDED_AD_MS = 10000;
const VIDEO_AD_MIN_MS = 5000;
const VIDEO_AD_SESSION_LIFETIME = 30 * 60 * 1000;

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
    message: "বন্ধুদের সঙ্গে তোমার Referral Link শেয়ার করো। তারা তোমার লিংক দিয়ে প্রথমবার Start করলেই তুমি Credit পাবে।",
    instructions: "১. Referral Link কপি করো।\n২. বন্ধুদের সঙ্গে শেয়ার করো।\n৩. তারা লিংক দিয়ে Start করলেই Credit যোগ হবে।"
  },

  ads: {
    network: "monetag",
    monetagZoneId: MONETAG_ZONE_ID,
    automaticAdsEnabled: true,
    autoFirstAdSeconds: 30,
    autoIntervalSeconds: 90,
    inAppFrequency: 4,
    inAppCappingHours: 2,
    rewardedInterstitialEnabled: true,
    adsPerVideo: 2,
    rewardedPopupEnabled: true,
    popupOnReferral: true,
    popupOnVideoUnlock: true,
    popupOnBonus: false
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

    const user = JSON.parse(params.get("user") || "null");

    if (user) {
      // Mini App "startapp" referral parameter (t.me/bot?startapp=ref_ID)
      user.__startParam = params.get("start_param") || "";
    }

    return user;
  } catch {
    return null;
  }
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

/* Telegram Long Polling */

let pollingRunning = false;
let pollingOffset = 0;

async function telegramGetUpdates() {
  if (!BOT_TOKEN) throw new Error("BOT_TOKEN is missing");

  const response = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        offset: pollingOffset,
        timeout: 25,
        allowed_updates: ["message"]
      })
    }
  );

  const result = await response.json();

  if (!response.ok || !result.ok) {
    throw new Error(
      result.description || `Telegram polling error (${response.status})`
    );
  }

  return result.result || [];
}

/* Video Mini App startapp Deep Link */

function buildVideoStartAppUrl(videoId) {
  if (!videoId) return "";

  const botUsername = String(
    VIDEO_BOT_USERNAME || "lexaadsbot"
  ).replace(/^@/, "");

  if (!botUsername) return "";

  const startParam = `v_${String(videoId)}`;

  return `https://t.me/${botUsername}?startapp=${encodeURIComponent(startParam)}`;
}

/* Save Telegram user */

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

/* Telegram user middleware (also handles startapp referral) */

async function requireTelegramUser(req, res, next) {
  const initData = req.get("x-telegram-init-data");
  const user = verifyTelegramInitData(initData);

  if (!user || !user.id) {
    return res.status(401).json({
      success: false,
      error: "Invalid Telegram session"
    });
  }

  try {
    const startParam = String(user.__startParam || "").trim();
    const result = await saveTelegramUser(user, startParam);

    if (result.isNewUser && /^ref_\d{1,20}$/.test(startParam)) {
      const ref = await processReferral(user.id, startParam);

      if (ref.success) {
        telegramRequest("sendMessage", {
          chat_id: ref.referrerId,
          text:
            `🎉 নতুন Referral!\n\n` +
            `একজন বন্ধু তোমার Referral Link দিয়ে অ্যাপ খুলেছে।\n` +
            `তোমার অ্যাকাউন্টে ${ref.reward} Credit যোগ হয়েছে।`
        }).catch(() => {});
      }
    }
  } catch (error) {
    console.error("Referral middleware error:", error.message);
  }

  req.telegramUser = user;
  next();
}

/* Referral system */

async function processReferral(newUserId, startParam = "") {
  const newId = String(newUserId || "").trim();

  if (!/^\d{1,20}$/.test(newId)) {
    return { success: false, reason: "Invalid new user ID" };
  }

  try {
    const claimRef = db.ref(`referralClaims/${newId}`);
    const newUserRef = db.ref(`users/${newId}`);

    const claimSnap = await claimRef.once("value");
    let claim = claimSnap.val() || null;

    let referrerId = "";
    const match = /^ref_(\d{1,20})$/.exec(
      String(startParam || "").trim()
    );

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
      // Firebase first runs with null (local cache), then retries with real data
      if (current === null) return current;

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
      if (current === null) return current;

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

/* Process Telegram /start update */

async function processTelegramUpdate(update) {
  const message = update?.message;

  if (!message || !message.from || !message.chat) return;

  const text = String(message.text || "").trim();

  if (!/^\/start(?:@\w+)?(?:\s|$)/.test(text)) return;

  const parts = text.split(/\s+/);
  const payload = parts[1] || "";

  await saveTelegramUser(message.from, payload);

  if (/^ref_\d{1,20}$/.test(payload)) {
    const referralResult = await processReferral(
      message.from.id,
      payload
    );

    if (referralResult.success) {
      try {
        await telegramRequest("sendMessage", {
          chat_id: referralResult.referrerId,
          text:
            `🎉 নতুন Referral!\n\n` +
            `একজন বন্ধু তোমার Referral Link দিয়ে Start করেছে।\n` +
            `তোমার অ্যাকাউন্টে ${referralResult.reward} Credit যোগ হয়েছে।`
        });
      } catch (notifyError) {
        console.error(
          "Referral notification failed:",
          notifyError.message
        );
      }
    } else if (
      ![
        "Already rewarded",
        "Self referral",
        "No referral",
        "Referral disabled",
        "User already referred",
        "User already referred by another person",
        "Referral claim mismatch"
      ].includes(referralResult.reason)
    ) {
      console.error(
        `Referral processing pending: user=${message.from.id}, reason=${referralResult.reason}`
      );
    }
  }

  /* Legacy /start v_VIDEO_ID links */

  const videoPayloadMatch =
    /^v_([a-zA-Z0-9_-]{1,150})$/.exec(payload);

  if (videoPayloadMatch) {
    const videoId = videoPayloadMatch[1];

    const videoSnap = await db.ref(`videos/${videoId}`).once("value");

    if (
      videoSnap.exists() &&
      videoSnap.val()?.enabled !== false
    ) {
      const videoAppUrl = buildVideoStartAppUrl(videoId);

      if (videoAppUrl) {
        await telegramRequest("sendMessage", {
          chat_id: message.chat.id,
          text:
            `🎬 ${videoSnap.val().title || "ভিডিও"}\n\n` +
            `নিচের বাটনে ক্লিক করলে সরাসরি এই ভিডিওটি খুলবে।`,
          reply_markup: {
            inline_keyboard: [[
              {
                text: "▶️ ভিডিও দেখুন",
                url: videoAppUrl
              }
            ]]
          }
        });

        return;
      }
    }
  }

  const botUsername = String(
    VIDEO_BOT_USERNAME || "lexaadsbot"
  ).replace(/^@/, "");

  const referralLink = botUsername
    ? `https://t.me/${botUsername}?start=ref_${message.from.id}`
    : "";

  const keyboard = WEB_APP_URL
    ? {
        inline_keyboard: [[
          {
            text: "🎬▶️ ভিডিও দেখুন",
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

  try {
    await telegramRequest("sendMessage", {
      chat_id: message.chat.id,
      text: welcomeText,
      reply_markup: keyboard
    });
  } catch (notifyError) {
    console.error(
      "Welcome message failed:",
      notifyError.message
    );
  }
}

/* Start Telegram Polling */

async function startTelegramPolling() {
  if (pollingRunning) return;

  if (!BOT_TOKEN) {
    console.error("Polling stopped: BOT_TOKEN is missing");
    return;
  }

  if (!firebaseReady) {
    console.error("Polling stopped: Firebase is not connected");
    return;
  }

  pollingRunning = true;

  try {
    await telegramRequest("deleteWebhook", {
      drop_pending_updates: false
    });

    console.log("Old Telegram webhook removed");
    console.log("Telegram Polling started");

    while (pollingRunning) {
      try {
        const updates = await telegramGetUpdates();

        for (const update of updates) {
          try {
            await processTelegramUpdate(update);
          } catch (error) {
            console.error(
              `Telegram update processing failed: update=${update.update_id}, reason=${error.message}`
            );
          }

          pollingOffset = Number(update.update_id) + 1;
        }
      } catch (error) {
        console.error("Telegram polling error:", error.message);

        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  } catch (error) {
    console.error("Could not start Telegram Polling:", error.message);
    pollingRunning = false;
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
      ...DEFAULT_SETTINGS.ads,
      ...savedAds,

      network: "monetag",
      monetagZoneId: MONETAG_ZONE_ID,

      automaticAdsEnabled:
        savedAds.automaticAdsEnabled !== false,

      autoFirstAdSeconds: Math.max(
        5,
        Math.min(3600, Number(savedAds.autoFirstAdSeconds) || 30)
      ),

      autoIntervalSeconds: Math.max(
        10,
        Math.min(3600, Number(savedAds.autoIntervalSeconds) || 90)
      ),

      inAppFrequency: Math.max(
        1,
        Math.min(20, Number(savedAds.inAppFrequency) || 4)
      ),

      inAppCappingHours: Math.max(
        1,
        Math.min(24, Number(savedAds.inAppCappingHours) || 2)
      ),

      rewardedInterstitialEnabled:
        savedAds.rewardedInterstitialEnabled !== false,

      adsPerVideo: Math.max(
        1,
        Math.min(
          100,
          Number(savedAds.adsPerVideo) ||
          DEFAULT_SETTINGS.ads.adsPerVideo
        )
      ),

      rewardedPopupEnabled:
        savedAds.rewardedPopupEnabled !== false,

      popupOnReferral:
        savedAds.popupOnReferral !== false,

      popupOnVideoUnlock:
        savedAds.popupOnVideoUnlock !== false,

      popupOnBonus:
        savedAds.popupOnBonus === true
    },

    pagination: {
      ...DEFAULT_SETTINGS.pagination,
      ...(saved.pagination || {})
    }
  };
}

/* Monetag Special Reward progress */

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

/* Video ad helper */

function getVideoAdsRequired(video, settings) {
  return Math.max(
    1,
    Math.min(
      100,
      Number(video.adsRequired) ||
      settings.ads.adsPerVideo ||
      DEFAULT_SETTINGS.ads.adsPerVideo
    )
  );
}

function buildVideoAdCountResponse(event, videoId, videoUrl) {
  const completed = Math.max(0, Number(event.completed) || 0);
  const required = Math.max(1, Number(event.required) || 1);
  const unlocked = event.unlocked === true;

  return {
    success: true,
    unlocked,
    videoId,
    completed: unlocked ? required : completed,
    required,
    remaining: unlocked
      ? 0
      : Math.max(0, required - completed),
    ...(unlocked ? { videoUrl } : {}),
    message: unlocked
      ? "Video unlocked successfully"
      : "Ad counted"
  };
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
      Math.min(
        50,
        Number(settingsSnap.val()) ||
        DEFAULT_SETTINGS.pagination.videosPerPage
      )
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

/* Video Ad Session Start */

app.post(
  "/api/video/ad/start",
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

      const [videoSnap, settingsSnap, progressSnap] = await Promise.all([
        db.ref(`videos/${videoId}`).once("value"),
        db.ref("settings").once("value"),
        db.ref(`users/${user.id}/videoAdProgress/${videoId}`).once("value")
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

      if (!settings.ads.rewardedInterstitialEnabled) {
        return res.status(403).json({
          success: false,
          error: "Video rewarded ads are disabled"
        });
      }

      const required = getVideoAdsRequired(video, settings);
      const progress = progressSnap.val() || {};

      const completed = Math.max(
        0,
        Number(progress.completed) || 0
      );

      if (completed >= required) {
        return res.json({
          success: true,
          unlocked: true,
          videoId,
          completed: required,
          required,
          remaining: 0,
          videoUrl: video.videoUrl,
          message: "Video already unlocked"
        });
      }

      const sessionId = crypto.randomBytes(18).toString("hex");
      const now = Date.now();

      await db.ref(
        `videoAdSessions/${user.id}/${sessionId}`
      ).set({
        userId: String(user.id),
        videoId,
        required,
        minimumWatchMs: VIDEO_AD_MIN_MS,
        createdAt: now,
        expiresAt: now + VIDEO_AD_SESSION_LIFETIME,
        status: "pending"
      });

      res.json({
        success: true,
        unlocked: false,
        sessionId,
        videoId,
        completed,
        required,
        remaining: Math.max(0, required - completed),
        minimumWatchMs: VIDEO_AD_MIN_MS,
        expiresAt: now + VIDEO_AD_SESSION_LIFETIME
      });
    } catch (error) {
      console.error("Video ad session start error:", error.message);

      res.status(500).json({
        success: false,
        error: "Could not start video ad session"
      });
    }
  }
);

/* Video Ad Count */

app.post(
  "/api/video/ad/count",
  requireFirebase,
  requireTelegramUser,
  async (req, res) => {
    try {
      const user = req.telegramUser;
      const videoId = String(req.body?.videoId || "").trim();
      const sessionId = String(req.body?.sessionId || "").trim();

      if (!/^[a-zA-Z0-9_-]{1,150}$/.test(videoId)) {
        return res.status(400).json({
          success: false,
          error: "Invalid video ID"
        });
      }

      if (!/^[a-f0-9]{36}$/.test(sessionId)) {
        return res.status(400).json({
          success: false,
          error: "Invalid ad session"
        });
      }

      const sessionRef = db.ref(
        `videoAdSessions/${user.id}/${sessionId}`
      );

      const [sessionSnap, videoSnap, settingsSnap] = await Promise.all([
        sessionRef.once("value"),
        db.ref(`videos/${videoId}`).once("value"),
        db.ref("settings").once("value")
      ]);

      if (!sessionSnap.exists()) {
        return res.status(404).json({
          success: false,
          error: "Ad session not found"
        });
      }

      const session = sessionSnap.val() || {};

      if (
        String(session.userId) !== String(user.id) ||
        String(session.videoId) !== videoId
      ) {
        return res.status(403).json({
          success: false,
          error: "Ad session mismatch"
        });
      }

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

      if (session.status === "counted" && session.result) {
        return res.json(
          buildVideoAdCountResponse(
            session.result,
            videoId,
            video.videoUrl
          )
        );
      }

      if (session.status !== "pending") {
        return res.status(409).json({
          success: false,
          error: "This ad session has already been used"
        });
      }

      const now = Date.now();

      if (
        !Number(session.expiresAt) ||
        Number(session.expiresAt) < now
      ) {
        return res.status(410).json({
          success: false,
          error: "Ad session expired. Please start again."
        });
      }

      const createdAt = Number(session.createdAt) || 0;
      const minimumWatchMs = Math.max(
        VIDEO_AD_MIN_MS,
        Number(session.minimumWatchMs) || 0
      );

      const elapsed = now - createdAt;

      if (elapsed < minimumWatchMs) {
        return res.status(429).json({
          success: false,
          error: "Please wait before counting this ad",
          retryAfterMs: minimumWatchMs - elapsed
        });
      }

      const settings = mergeSettings(settingsSnap.val() || {});

      if (!settings.ads.rewardedInterstitialEnabled) {
        return res.status(403).json({
          success: false,
          error: "Video rewarded ads are disabled"
        });
      }

      const required = Math.max(
        1,
        Math.min(
          100,
          Number(session.required) ||
          getVideoAdsRequired(video, settings)
        )
      );

      const progressRef = db.ref(
        `users/${user.id}/videoAdProgress/${videoId}`
      );

      const progressResult = await progressRef.transaction(current => {
        current = current || {};
        current.sessions = current.sessions || {};

        if (current.sessions[sessionId]) {
          return current;
        }

        let completed = Math.max(
          0,
          Number(current.completed) || 0
        );

        completed += 1;

        const unlocked = completed >= required;
        const countTime = Date.now();

        const event = {
          countedAt: countTime,
          unlocked,
          required,
          completed: unlocked ? required : completed,
          remaining: unlocked
            ? 0
            : Math.max(0, required - completed)
        };

        current.sessions[sessionId] = event;

        for (const [id, savedEvent] of Object.entries(current.sessions)) {
          if (
            Number(savedEvent?.countedAt || 0) <
            countTime - 24 * 60 * 60 * 1000
          ) {
            delete current.sessions[id];
          }
        }

        if (unlocked) {
          return {
            completed: 0,
            required,
            sessions: current.sessions,

            totalAdsCompleted:
              (Number(current.totalAdsCompleted) || 0) + completed,

            totalUnlocks:
              (Number(current.totalUnlocks) || 0) + 1,

            lastUnlockAt: countTime,
            lastCountAt: countTime,
            updatedAt: countTime
          };
        }

        return {
          ...current,
          completed,
          required,
          sessions: current.sessions,
          lastCountAt: countTime,
          updatedAt: countTime
        };
      });

      if (!progressResult.committed) {
        return res.status(500).json({
          success: false,
          error: "Could not update video ad progress"
        });
      }

      const updated = progressResult.snapshot.val() || {};
      const eventResult = updated.sessions?.[sessionId];

      if (!eventResult) {
        return res.status(500).json({
          success: false,
          error: "Could not confirm ad count"
        });
      }

      const responseResult = {
        countedAt: Number(eventResult.countedAt) || Date.now(),
        unlocked: eventResult.unlocked === true,
        required: Number(eventResult.required) || required,
        completed: Number(eventResult.completed) || 0,
        remaining: Number(eventResult.remaining) || 0
      };

      await sessionRef.update({
        status: "counted",
        countedAt: responseResult.countedAt,
        result: responseResult
      });

      if (responseResult.unlocked) {
        console.log(
          `Video unlocked: user=${user.id}, video=${videoId}`
        );
      } else {
        console.log(
          `Video ad counted: user=${user.id}, video=${videoId}, completed=${responseResult.completed}/${responseResult.required}`
        );
      }

      return res.json(
        buildVideoAdCountResponse(
          responseResult,
          videoId,
          video.videoUrl
        )
      );
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

      let deducted = false;

      const transaction = await creditRef.transaction(current => {
        deducted = false;

        // Firebase first runs with null (local cache), then retries with real data
        if (current === null) return current;

        const balance = Math.max(0, Number(current) || 0);

        if (balance < 1) return;

        deducted = true;
        return balance - 1;
      });

      if (!transaction.committed || !deducted) {
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

      // New app open: video ad progress starts again from zero
      if (req.query.newSession === "1") {
        await Promise.all([
          db.ref(`users/${user.id}/videoAdProgress`).remove(),
          db.ref(`videoAdSessions/${user.id}`).remove()
        ]);
      }

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

/* Special Reward ad verification */

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

        current.completed = Math.max(
          0,
          Number(current.completed) || 0
        );

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

      const status = getRewardStatus(
        settings,
        latestUserSnap.val() || {}
      );

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
      let blockedUsers = 0;

      users.forEach(child => {
        const user = child.val() || {};
        totalReferrals += Number(user.totalReferrals) || 0;
        totalCredits += Number(user.credits) || 0;
        if (user.blocked === true) blockedUsers++;
      });

      res.json({
        success: true,
        totalUsers: users.numChildren(),
        blockedUsers,
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
        if (req.body[key] !== undefined) {
          updates[key] = req.body[key];
        }
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

        if (
          !Number.isInteger(adsRequired) ||
          adsRequired < 1 ||
          adsRequired > 1000
        ) {
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

            if (
              parsed.protocol !== "https:" &&
              parsed.protocol !== "http:"
            ) {
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

        if (
          !Number.isFinite(reward) ||
          reward < 0 ||
          reward > 1000000
        ) {
          return res.status(400).json({
            success: false,
            error: "Referral reward must be between 0 and 1000000"
          });
        }

        if (
          title.length > 150 ||
          message.length > 2000 ||
          instructions.length > 2000
        ) {
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

        const inAppFrequency =
          incoming.inAppFrequency !== undefined
            ? Number(incoming.inAppFrequency)
            : Number(current.inAppFrequency) || 4;

        const inAppCappingHours =
          incoming.inAppCappingHours !== undefined
            ? Number(incoming.inAppCappingHours)
            : Number(current.inAppCappingHours) || 2;

        if (
          !Number.isInteger(adsPerVideo) ||
          adsPerVideo < 1 ||
          adsPerVideo > 100
        ) {
          return res.status(400).json({
            success: false,
            error: "Ads per video must be between 1 and 100"
          });
        }

        if (
          !Number.isInteger(autoFirstAdSeconds) ||
          autoFirstAdSeconds < 5 ||
          autoFirstAdSeconds > 3600
        ) {
          return res.status(400).json({
            success: false,
            error: "First automatic ad delay must be 5-3600 seconds"
          });
        }

        if (
          !Number.isInteger(autoIntervalSeconds) ||
          autoIntervalSeconds < 10 ||
          autoIntervalSeconds > 3600
        ) {
          return res.status(400).json({
            success: false,
            error: "Automatic ad interval must be 10-3600 seconds"
          });
        }

        if (
          !Number.isInteger(inAppFrequency) ||
          inAppFrequency < 1 ||
          inAppFrequency > 20
        ) {
          return res.status(400).json({
            success: false,
            error: "In-App frequency must be between 1 and 20"
          });
        }

        if (
          !Number.isInteger(inAppCappingHours) ||
          inAppCappingHours < 1 ||
          inAppCappingHours > 24
        ) {
          return res.status(400).json({
            success: false,
            error: "In-App capping must be between 1 and 24 hours"
          });
        }

        function toBoolean(value, fallback) {
          if (value === undefined || value === null) return fallback;

          if (value === true || value === "true" || value === 1) {
            return true;
          }

          if (value === false || value === "false" || value === 0) {
            return false;
          }

          return fallback;
        }

        updates.ads = {
          ...current,
          ...incoming,

          network: "monetag",
          monetagZoneId: MONETAG_ZONE_ID,

          automaticAdsEnabled: toBoolean(
            incoming.automaticAdsEnabled,
            current.automaticAdsEnabled !== false
          ),

          autoFirstAdSeconds,
          autoIntervalSeconds,
          inAppFrequency,
          inAppCappingHours,

          rewardedInterstitialEnabled: toBoolean(
            incoming.rewardedInterstitialEnabled,
            current.rewardedInterstitialEnabled !== false
          ),

          adsPerVideo,

          rewardedPopupEnabled: toBoolean(
            incoming.rewardedPopupEnabled,
            current.rewardedPopupEnabled !== false
          ),

          popupOnReferral: toBoolean(
            incoming.popupOnReferral,
            current.popupOnReferral !== false
          ),

          popupOnVideoUnlock: toBoolean(
            incoming.popupOnVideoUnlock,
            current.popupOnVideoUnlock !== false
          ),

          popupOnBonus: toBoolean(
            incoming.popupOnBonus,
            current.popupOnBonus === true
          )
        };
      }

      await db.ref("settings").update(updates);

      res.json({
        success: true,
        message: "Settings updated"
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
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

        if (video) {
          videos.push({ id: child.key, ...video });
        }
      });

      videos.reverse();

      res.json({ success: true, videos });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

/* Notifications: run in background with live status */

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const NOTIFY_BATCH_SIZE = 20;
const NOTIFY_BATCH_DELAY_MS = 1000;
const MAX_JOBS_IN_MEMORY = 30;

const notificationJobs = new Map();
let notificationQueue = Promise.resolve();

function isBlockedError(message) {
  return /blocked|chat not found|deactivated/i.test(String(message || ""));
}

function getRetryAfterMs(message) {
  const match = /retry after (\d+)/i.exec(String(message || ""));
  if (!match) return 0;
  return Math.min(30, Number(match[1]) + 1) * 1000;
}

function saveNotificationJob(job) {
  return db.ref(`notificationJobs/${job.id}`).set(job).catch(error => {
    console.error("Notification job save failed:", error.message);
  });
}

async function sendNotificationToUser(id, video, caption, keyboard) {
  const attempt = async () => {
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
        if (
          isBlockedError(photoError.message) ||
          getRetryAfterMs(photoError.message)
        ) {
          throw photoError;
        }

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
  };

  try {
    await attempt();
  } catch (error) {
    const waitMs = getRetryAfterMs(error.message);

    if (!waitMs) throw error;

    await sleep(waitMs);
    await attempt();
  }
}

async function runNotificationJob(job, video, options) {
  job.status = "running";
  job.startedAt = Date.now();
  await saveNotificationJob(job);

  const videoAppUrl = buildVideoStartAppUrl(video.id);

  if (!videoAppUrl) {
    throw new Error("Video Mini App Deep Link could not be created");
  }

  const title = String(video.title || "নতুন ভিডিও").slice(0, 200);
  const description = String(video.description || "").slice(0, 700);

  // Edited-video notification: only the saved title (no extra words)
  const caption = options.titleOnly
    ? title
    : `🎬 ${title}\n\n` +
      (description ? `${description}\n\n` : "") +
      `📺 Premium Video-তে দেখতে নিচের বাটনে ক্লিক করো।`;

  const keyboard = {
    inline_keyboard: [[
      {
        text: "▶️ ভিডিও দেখুন",
        url: videoAppUrl
      }
    ]]
  };

  const snapshot = await db.ref("users").once("value");
  const users = snapshot.val() || {};
  const allIds = Object.keys(users);

  // Users who already blocked the bot are skipped
  const ids = allIds.filter(id => users[id] && users[id].blocked !== true);

  job.total = ids.length;
  job.skipped = allIds.length - ids.length;
  await saveNotificationJob(job);

  for (let i = 0; i < ids.length; i += NOTIFY_BATCH_SIZE) {
    const batch = ids.slice(i, i + NOTIFY_BATCH_SIZE);

    await Promise.all(batch.map(async id => {
      try {
        await sendNotificationToUser(id, video, caption, keyboard);
        job.sent++;
      } catch (error) {
        job.failed++;

        if (isBlockedError(error.message)) {
          job.blocked++;
          db.ref(`users/${id}`).update({ blocked: true }).catch(() => {});
        } else {
          job.otherFailed++;

          if (job.errors.length < 5) {
            job.errors.push(String(error.message).slice(0, 200));
          }
        }
      } finally {
        job.processed++;
      }
    }));

    await saveNotificationJob(job);
    await sleep(NOTIFY_BATCH_DELAY_MS);
  }

  job.status = "done";
  job.finishedAt = Date.now();
  await saveNotificationJob(job);

  console.log(
    `Notification job done: id=${job.id}, total=${job.total}, sent=${job.sent}, failed=${job.failed}, blocked=${job.blocked}, skipped=${job.skipped}`
  );
}

function startNotificationJob(video, options = {}) {
  const job = {
    id: crypto.randomBytes(8).toString("hex"),
    type: options.titleOnly ? "edit" : "new",
    videoId: String(video.id || ""),
    title: String(video.title || "").slice(0, 200),
    status: "queued",
    total: 0,
    processed: 0,
    sent: 0,
    failed: 0,
    blocked: 0,
    otherFailed: 0,
    skipped: 0,
    errors: [],
    error: "",
    createdAt: Date.now(),
    startedAt: 0,
    finishedAt: 0
  };

  notificationJobs.set(job.id, job);

  if (notificationJobs.size > MAX_JOBS_IN_MEMORY) {
    const oldest = [...notificationJobs.values()]
      .sort((a, b) => a.createdAt - b.createdAt)[0];

    if (oldest && oldest.id !== job.id) notificationJobs.delete(oldest.id);
  }

  saveNotificationJob(job);

  // Jobs run one after another in the background
  notificationQueue = notificationQueue
    .then(() => runNotificationJob(job, video, options))
    .catch(async error => {
      console.error("Notification job failed:", error.message);

      job.status = "failed";
      job.error = String(error.message).slice(0, 300);
      job.finishedAt = Date.now();

      await saveNotificationJob(job);
    });

  return job;
}

async function markInterruptedNotificationJobs() {
  if (!firebaseReady) return;

  try {
    const snap = await db.ref("notificationJobs")
      .orderByChild("createdAt")
      .limitToLast(50)
      .once("value");

    const updates = {};

    snap.forEach(child => {
      const job = child.val() || {};

      if (job.status === "running" || job.status === "queued") {
        updates[`${child.key}/status`] = "interrupted";
        updates[`${child.key}/finishedAt`] = Date.now();
      }
    });

    if (Object.keys(updates).length) {
      await db.ref("notificationJobs").update(updates);
    }
  } catch (error) {
    console.error("Notification job cleanup error:", error.message);
  }
}

/* Admin: notification status */

app.get(
  "/api/admin/notifications",
  requireFirebase,
  requireAdmin,
  async (req, res) => {
    try {
      const merged = new Map();

      const snap = await db.ref("notificationJobs")
        .orderByChild("createdAt")
        .limitToLast(20)
        .once("value");

      snap.forEach(child => {
        const job = child.val();
        if (job && job.id) merged.set(job.id, job);
      });

      // Live in-memory jobs are newer than the saved copy
      for (const [id, job] of notificationJobs) {
        merged.set(id, job);
      }

      const jobs = [...merged.values()]
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

      res.json({ success: true, jobs: jobs.slice(0, 20) });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

function isActiveNotificationJob(job) {
  return job && (job.status === "running" || job.status === "queued");
}

/* Admin: delete one finished notification record */

app.delete(
  "/api/admin/notifications/:id",
  requireFirebase,
  requireAdmin,
  async (req, res) => {
    try {
      const id = String(req.params.id || "");

      if (!/^[a-f0-9]{16}$/.test(id)) {
        return res.status(400).json({
          success: false,
          error: "Invalid notification ID"
        });
      }

      let job = notificationJobs.get(id);

      if (!job) {
        const snap = await db.ref(`notificationJobs/${id}`).once("value");
        job = snap.val();
      }

      if (!job) {
        return res.status(404).json({
          success: false,
          error: "Notification job not found"
        });
      }

      if (isActiveNotificationJob(job)) {
        return res.status(409).json({
          success: false,
          error: "This notification is still being sent"
        });
      }

      notificationJobs.delete(id);
      await db.ref(`notificationJobs/${id}`).remove();

      res.json({ success: true, message: "Notification record deleted" });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

/* Admin: clear all finished notification records */

app.delete(
  "/api/admin/notifications",
  requireFirebase,
  requireAdmin,
  async (req, res) => {
    try {
      const snap = await db.ref("notificationJobs").once("value");
      const updates = {};
      let deleted = 0;

      snap.forEach(child => {
        const job = notificationJobs.get(child.key) || child.val() || {};

        if (!isActiveNotificationJob(job)) {
          updates[child.key] = null;
          deleted++;
        }
      });

      if (deleted) {
        await db.ref("notificationJobs").update(updates);
      }

      for (const [id, job] of notificationJobs) {
        if (!isActiveNotificationJob(job)) notificationJobs.delete(id);
      }

      res.json({ success: true, deleted });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

app.get(
  "/api/admin/notifications/:id",
  requireFirebase,
  requireAdmin,
  async (req, res) => {
    try {
      let job = notificationJobs.get(req.params.id);

      if (!job) {
        const snap = await db
          .ref(`notificationJobs/${req.params.id}`)
          .once("value");

        job = snap.val();
      }

      if (!job) {
        return res.status(404).json({
          success: false,
          error: "Notification job not found"
        });
      }

      res.json({ success: true, job });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

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

      if (
        !Number.isInteger(required) ||
        required < 1 ||
        required > 100
      ) {
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

      let notificationJobId = "";

      try {
        const job = startNotificationJob({
          id: videoRef.key,
          ...video
        });

        notificationJobId = job.id;
      } catch (error) {
        console.error("Notification error:", error.message);
      }

      res.json({
        success: true,
        videoId: videoRef.key,
        notifiedUsers: 0,
        notificationJobId,
        notificationStatus: notificationJobId ? "started" : "not_started",
        message: "Video added. Notifications are sending in the background."
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
        if (req.body[key] !== undefined) {
          updates[key] = req.body[key];
        }
      }

      if (updates.adsRequired !== undefined) {
        const required = Number(updates.adsRequired);

        if (
          !Number.isInteger(required) ||
          required < 1 ||
          required > 100
        ) {
          return res.status(400).json({
            success: false,
            error: "Ads Required must be between 1 and 100"
          });
        }

        updates.adsRequired = required;
      }

      await ref.update(updates);

      // Notify users again after an edit: same title + thumbnail, no extra text
      let notificationJobId = "";

      try {
        const latestSnap = await ref.once("value");
        const latest = latestSnap.val() || {};

        if (latest.enabled !== false) {
          const job = startNotificationJob(
            { id: req.params.id, ...latest },
            { titleOnly: true }
          );

          notificationJobId = job.id;
        }
      } catch (error) {
        console.error("Edit notification error:", error.message);
      }

      res.json({
        success: true,
        notifiedUsers: 0,
        notificationJobId,
        notificationStatus: notificationJobId ? "started" : "not_started",
        message: "Video updated"
      });
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

/* Admin: delete all data of users who blocked the bot */

app.delete(
  "/api/admin/users/blocked",
  requireFirebase,
  requireAdmin,
  async (req, res) => {
    try {
      const usersSnap = await db.ref("users").once("value");
      const users = usersSnap.val() || {};

      const blockedIds = Object.keys(users).filter(
        id => users[id] && users[id].blocked === true
      );

      if (!blockedIds.length) {
        return res.json({ success: true, deleted: 0 });
      }

      const blockedSet = new Set(blockedIds);

      // 1) Remove the old referral record from each referrer, so the
      //    referrer is rewarded again when the user comes back via the link
      const byReferrer = new Map();

      for (const id of blockedIds) {
        const referrerId = String(users[id].referredBy || "");

        if (!referrerId || blockedSet.has(referrerId) || !users[referrerId]) {
          continue;
        }

        if (!byReferrer.has(referrerId)) byReferrer.set(referrerId, []);
        byReferrer.get(referrerId).push(id);
      }

      for (const [referrerId, ids] of byReferrer) {
        await db.ref(`users/${referrerId}`).transaction(current => {
          if (current === null) return current;
          if (!current.referrals) return current;

          let removed = 0;

          for (const id of ids) {
            if (current.referrals[id]) {
              delete current.referrals[id];
              removed++;
            }
          }

          if (removed) {
            current.totalReferrals = Math.max(
              0,
              (Number(current.totalReferrals) || 0) - removed
            );

            if (!Object.keys(current.referrals).length) {
              delete current.referrals;
            }
          }

          return current;
        });
      }

      // 2) Remove pending referral claims whose referrer is being deleted
      const claimsSnap = await db.ref("referralClaims").once("value");
      const claims = claimsSnap.val() || {};
      const claimUpdates = {};

      for (const [newUserId, claim] of Object.entries(claims)) {
        if (
          claim &&
          claim.status === "pending" &&
          blockedSet.has(String(claim.referrerId))
        ) {
          claimUpdates[newUserId] = null;
        }
      }

      if (Object.keys(claimUpdates).length) {
        await db.ref("referralClaims").update(claimUpdates);
      }

      // 3) Delete the users and their related records everywhere
      for (let i = 0; i < blockedIds.length; i += 100) {
        const chunk = blockedIds.slice(i, i + 100);
        const updates = {};

        chunk.forEach(id => {
          updates[`users/${id}`] = null;
          updates[`referralClaims/${id}`] = null;
          updates[`videoAdSessions/${id}`] = null;
        });

        await db.ref().update(updates);
      }

      console.log(`Blocked users deleted: ${blockedIds.length}`);

      res.json({ success: true, deleted: blockedIds.length });
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

        results.forEach((result, index) => {
          if (result.status === "fulfilled") {
            sent++;
          } else {
            failed++;

            if (isBlockedError(result.reason && result.reason.message)) {
              db.ref(`users/${batch[index]}`)
                .update({ blocked: true })
                .catch(() => {});
            }
          }
        });
      }

      res.json({
        success: true,
        total: ids.length,
        sent,
        failed
      });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

/* Home route */

app.get("/", (req, res) => {
  res.send("Premium Video Backend is running");
});

/* Start server */

app.listen(PORT, () => {
  console.log(`Premium Video server running on port ${PORT}`);

  setTimeout(() => {
    startTelegramPolling();
  }, 2000);

  setTimeout(() => {
    markInterruptedNotificationJobs();
  }, 1000);

  setTimeout(() => {
    recoverPendingReferralClaims();
  }, 5000);

  setInterval(() => {
    recoverPendingReferralClaims();
  }, 60000);
});
