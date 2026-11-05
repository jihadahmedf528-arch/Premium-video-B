
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

const ADEXIUM_DEFAULT_WID =
  "d7ac754e-70bc-484b-8346-75eb7b5fa3b6";

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
    unlockMessage:
      "৫০টি বিজ্ঞাপন সম্পন্ন করে তোমার Reward Unlock করো!"
  },

  referral: {
    enabled: true,
    rewardPerReferral: 1
  },

  ads: {
    adexiumEnabled: true,
    adexiumWidgetId: ADEXIUM_DEFAULT_WID,
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
    console.error(
      "Firebase initialization failed:",
      error.message
    );
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
  if (
    typeof a !== "string" ||
    typeof b !== "string"
  ) {
    return false;
  }

  const first = Buffer.from(a);
  const second = Buffer.from(b);

  return (
    first.length === second.length &&
    crypto.timingSafeEqual(first, second)
  );
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

    if (!safeCompare(calculatedHash, hash)) {
      return null;
    }

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
  if (!BOT_TOKEN) {
    throw new Error("BOT_TOKEN is missing");
  }

  const response = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }
  );

  const result = await response.json();

  if (!response.ok || !result.ok) {
    throw new Error(
      result.description ||
      `Telegram API error (${response.status})`
    );
  }

  return result.result;
}

/* Save Telegram user */

async function saveTelegramUser(user, startParam = "") {
  if (!user || !user.id) {
    throw new Error("Invalid Telegram user");
  }

  const userRef = db.ref(`users/${user.id}`);
  const snapshot = await userRef.once("value");

  const oldUser = snapshot.val() || {};
  const isNewUser = !snapshot.exists();

  await userRef.update({
    telegramId: String(user.id),

    firstName:
      user.first_name ||
      oldUser.firstName ||
      "",

    lastName:
      user.last_name ||
      oldUser.lastName ||
      "",

    username:
      user.username ||
      oldUser.username ||
      "",

    languageCode:
      user.language_code ||
      oldUser.languageCode ||
      "",

    isPremium: !!user.is_premium,

    joinedAt: oldUser.joinedAt || Date.now(),
    lastActive: Date.now(),

    startParam:
      startParam ||
      oldUser.startParam ||
      "",

    credits: Number(oldUser.credits) || 0,

    totalReferrals:
      Number(oldUser.totalReferrals) || 0,

    blocked: false
  });

  return { isNewUser };
}

/* Referral system */

async function processReferral(
  newUserId,
  startParam = "",
  isNewUser = false
) {
  const match = /^ref_(\d{1,20})$/.exec(
    String(startParam || "")
  );

  if (!match) {
    return {
      success: false,
      reason: "No referral"
    };
  }

  const referrerId = match[1];
  const newId = String(newUserId);

  if (!newId || referrerId === newId) {
    return {
      success: false,
      reason: "Self referral"
    };
  }

  const claimRef = db.ref(`referralClaims/${newId}`);
  const existingClaim = await claimRef.once("value");

  let claim = existingClaim.val();

  if (!claim) {
    if (!isNewUser) {
      return {
        success: false,
        reason: "User is not newly registered"
      };
    }

    const settingsSnap = await db
      .ref("settings/referral")
      .once("value");

    const referralSettings = {
      ...DEFAULT_SETTINGS.referral,
      ...(settingsSnap.val() || {})
    };

    if (!referralSettings.enabled) {
      return {
        success: false,
        reason: "Referral disabled"
      };
    }

    const reward = Number(
      referralSettings.rewardPerReferral
    );

    if (
      !Number.isFinite(reward) ||
      reward <= 0 ||
      reward > 1000000
    ) {
      return {
        success: false,
        reason: "Invalid referral reward"
      };
    }

    const referrerSnap = await db
      .ref(`users/${referrerId}`)
      .once("value");

    if (!referrerSnap.exists()) {
      return {
        success: false,
        reason: "Referrer not found"
      };
    }

    const newUserSnap = await db
      .ref(`users/${newId}`)
      .once("value");

    const newUserData = newUserSnap.val() || {};

    if (newUserData.referredBy) {
      return {
        success: false,
        reason: "User already referred"
      };
    }

    const claimResult = await claimRef.transaction(
      current => {
        if (current) return;

        return {
          referrerId,
          newUserId: newId,
          reward,
          status: "pending",
          createdAt: Date.now()
        };
      }
    );

    claim = claimResult.snapshot.val();
  }

  if (
    !claim ||
    String(claim.referrerId) !== referrerId
  ) {
    return {
      success: false,
      reason: "Referral claim mismatch"
    };
  }

  if (claim.status === "completed") {
    return {
      success: false,
      reason: "Already rewarded"
    };
  }

  const reward = Number(claim.reward);

  if (!Number.isFinite(reward) || reward <= 0) {
    return {
      success: false,
      reason: "Invalid stored reward"
    };
  }

  const referrerRef = db.ref(`users/${referrerId}`);

  const referrerResult = await referrerRef.transaction(
    user => {
      if (!user) return;

      user.referrals = user.referrals || {};

      if (user.referrals[newId]) {
        return user;
      }

      user.credits =
        (Number(user.credits) || 0) + reward;

      user.totalReferrals =
        (Number(user.totalReferrals) || 0) + 1;

      user.referrals[newId] = {
        reward,
        createdAt:
          Number(claim.createdAt) || Date.now()
      };

      return user;
    }
  );

  if (!referrerResult.committed) {
    const latestReferrer = await referrerRef.once("value");
    const latestData = latestReferrer.val() || {};

    if (
      !latestData.referrals ||
      !latestData.referrals[newId]
    ) {
      return {
        success: false,
        reason: "Could not apply referral reward"
      };
    }
  }

  await db.ref(`users/${newId}`).update({
    referredBy: referrerId,
    referredAt:
      Number(claim.createdAt) || Date.now()
  });

  await claimRef.update({
    status: "completed",
    completedAt: Date.now()
  });

  return {
    success: true,
    reward
  };
}

/* Merge settings */

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
      adexiumEnabled:
        savedAds.adexiumEnabled !== false,

      adexiumWidgetId:
        String(
          savedAds.adexiumWidgetId ||
          ADEXIUM_DEFAULT_WID
        ),

      adsPerVideo: Math.max(
        1,
        Math.min(
          100,
          Number(savedAds.adsPerVideo) ||
          DEFAULT_SETTINGS.ads.adsPerVideo
        )
      )
    },

    pagination: {
      ...DEFAULT_SETTINGS.pagination,
      ...(saved.pagination || {})
    }
  };
}

/* Adexium Reward progress */

function getRewardProgress(userData = {}) {
  const progress = userData.adexiumRewardProgress || {};

  return {
    completed: Math.max(
      0,
      Number(progress.completed) || 0
    ),
    events: progress.events || {}
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

  const unlocked =
    enabled &&
    !!reward.unlockUrl &&
    progress.completed >= required;

  return {
    success: true,
    enabled,
    completed: progress.completed,
    required,
    unlocked,
    unlockMessage: reward.unlockMessage || "",
    ...(unlocked
      ? { unlockUrl: reward.unlockUrl }
      : {})
  };
}

/* Health check */

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    firebase: firebaseReady,
    app: "Premium Video"
  });
});

/* Public settings */

app.get(
  "/api/settings",
  requireFirebase,
  async (req, res) => {
    try {
      const snapshot = await db
        .ref("settings")
        .once("value");

      const settings = mergeSettings(
        snapshot.val() || {}
      );

      settings.reward.unlockUrl = "";

      res.json({
        success: true,
        settings
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

/* Private admin settings */

app.get(
  "/api/admin/settings",
  requireFirebase,
  requireAdmin,
  async (req, res) => {
    try {
      const snapshot = await db
        .ref("settings")
        .once("value");

      res.json({
        success: true,
        settings: mergeSettings(
          snapshot.val() || {}
        )
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

/* Public video listing */

app.get(
  "/api/videos",
  requireFirebase,
  async (req, res) => {
    try {
      const page = Math.max(
        1,
        Number(req.query.page) || 1
      );

      const category = String(
        req.query.category || "all"
      );

      const snapshot = await db
        .ref("videos")
        .orderByChild("createdAt")
        .once("value");

      let videos = [];

      snapshot.forEach(child => {
        const video = child.val();

        if (video && video.enabled !== false) {
          const {
            videoUrl,
            ...publicVideo
          } = video;

          videos.push({
            id: child.key,
            ...publicVideo
          });
        }
      });

      videos.reverse();

      if (category !== "all") {
        videos = videos.filter(
          video => video.categoryId === category
        );
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

      const totalPages = Math.max(
        1,
        Math.ceil(total / perPage)
      );

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
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

/* Video unlock using referral credits */

app.post(
  "/api/video/unlock",
  requireFirebase,
  requireTelegramUser,
  async (req, res) => {
    try {
      const user = req.telegramUser;

      const videoId = String(
        req.body?.videoId || ""
      ).trim();

      const requestId = String(
        req.body?.requestId || ""
      ).trim();

      if (
        !videoId ||
        videoId.length > 150 ||
        !/^[a-zA-Z0-9_-]+$/.test(videoId)
      ) {
        return res.status(400).json({
          success: false,
          error: "Invalid video ID"
        });
      }

      if (
        !requestId ||
        requestId.length > 100 ||
        !/^[a-zA-Z0-9_-]+$/.test(requestId)
      ) {
        return res.status(400).json({
          success: false,
          error: "Invalid request ID"
        });
      }

      await saveTelegramUser(user);

      const videoRef = db.ref(`videos/${videoId}`);
      const videoSnap = await videoRef.once("value");

      if (
        !videoSnap.exists() ||
        videoSnap.val()?.enabled === false
      ) {
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

      /*
       * Prevent duplicate requests from charging twice.
       */

      const requestHash = crypto
        .createHash("sha256")
        .update(String(user.id) + ":" + requestId)
        .digest("hex");

      const claimRef = db.ref(
        `videoUnlockClaims/${requestHash}`
      );

      const claimResult = await claimRef.transaction(
        current => {
          if (current) return;

          return {
            userId: String(user.id),
            videoId,
            status: "processing",
            createdAt: Date.now()
          };
        }
      );

      if (!claimResult.committed) {
        return res.status(409).json({
          success: false,
          error: "This unlock request was already used"
        });
      }

      /*
       * One new request = one credit.
       * Rewatching the same video also costs one credit.
       */

      const userRef = db.ref(`users/${user.id}`);

      const chargeResult = await userRef.transaction(
        current => {
          if (!current) return;

          const credits = Number(current.credits) || 0;

          if (credits < 1) return;

          current.credits = credits - 1;

          current.videoUnlocks =
            current.videoUnlocks || {};

          current.videoUnlocks[videoId] =
            (Number(current.videoUnlocks[videoId]) || 0) + 1;

          current.lastVideoUnlockAt = Date.now();

          return current;
        }
      );

      if (!chargeResult.committed) {
        await claimRef.update({
          status: "failed",
          reason: "Insufficient credits",
          completedAt: Date.now()
        });

        return res.status(403).json({
          success: false,
          error: "Not enough credits",
          credits: Number(
            chargeResult.snapshot.val()?.credits
          ) || 0
        });
      }

      await claimRef.update({
        status: "completed",
        completedAt: Date.now()
      });

      const updatedUser = chargeResult.snapshot.val() || {};

      console.log(
        `Video unlocked: user=${user.id}, video=${videoId}, credits=${updatedUser.credits}`
      );

      return res.json({
        success: true,
        message: "Video unlocked successfully",
        videoId,
        videoUrl: video.videoUrl,
        credits: Number(updatedUser.credits) || 0
      });

    } catch (error) {
      console.error(
        "Video unlock error:",
        error.message
      );

      return res.status(500).json({
        success: false,
        error: "Could not unlock video"
      });
    }
  }
);

/* Verify Mini App user */

app.get(
  "/api/me",
  requireFirebase,
  requireTelegramUser,
  async (req, res) => {
    try {
      const user = req.telegramUser;

      await saveTelegramUser(user);

      const snapshot = await db
        .ref(`users/${user.id}`)
        .once("value");

      const data = snapshot.val() || {};

      res.json({
        success: true,

        user: {
          ...data,
          id: String(user.id),
          credits: Number(data.credits) || 0,
          totalReferrals:
            Number(data.totalReferrals) || 0
        }
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

/* Get reward status */

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

      const settings = mergeSettings(
        settingsSnap.val() || {}
      );

      const userData = userSnap.val() || {};

      res.json(
        getRewardStatus(settings, userData)
      );
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

/* Verify Adexium task and credit reward */

app.post(
  "/api/reward/verify",
  requireFirebase,
  requireTelegramUser,
  async (req, res) => {
    try {
      const user = req.telegramUser;
      const taskId = String(req.body.taskId || "").trim();

      if (
        !taskId ||
        taskId.length > 250 ||
        !/^[a-zA-Z0-9_-]+$/.test(taskId)
      ) {
        return res.status(400).json({
          success: false,
          error: "Invalid Adexium task ID"
        });
      }

      await saveTelegramUser(user);

      const [settingsSnap, userSnap] = await Promise.all([
        db.ref("settings").once("value"),
        db.ref(`users/${user.id}`).once("value")
      ]);

      const settings = mergeSettings(
        settingsSnap.val() || {}
      );

      const userData = userSnap.val() || {};
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

      if (settings.ads.adexiumEnabled === false) {
        return res.status(403).json({
          success: false,
          error: "Adexium ads are disabled"
        });
      }

      const wid = settings.ads.adexiumWidgetId;

      if (!wid || wid.length > 150) {
        return res.status(500).json({
          success: false,
          error: "Adexium Widget ID is invalid"
        });
      }

      /*
       * Verify the task directly with Adexium.
       * Client-side playback events are not trusted.
       */

      const verifyUrl =
        "https://bid.tgads.live/task/check/" +
        encodeURIComponent(wid) + "/" +
        encodeURIComponent(taskId);

      const verifyResponse = await fetch(verifyUrl, {
        method: "GET",
        headers: {
          "Accept": "application/json"
        },
        signal: AbortSignal.timeout(12000)
      });

      if (!verifyResponse.ok) {
        console.error(
          "Adexium verification HTTP status:",
          verifyResponse.status
        );

        return res.status(502).json({
          success: false,
          error: "Adexium verification service unavailable"
        });
      }

      const verification = await verifyResponse.json();

      if (verification.done !== true) {
        return res.status(403).json({
          success: false,
          error: "Adexium has not confirmed this ad task"
        });
      }

      /*
       * A global task claim prevents a task from
       * being credited to multiple Telegram users.
       */

      const taskHash = crypto
        .createHash("sha256")
        .update(taskId)
        .digest("hex");

      const claimRef = db.ref(
        `adexiumTaskClaims/${taskHash}`
      );

      const claimResult = await claimRef.transaction(
        current => {
          if (current) return;

          return {
            userId: String(user.id),
            createdAt: Date.now(),
            status: "claimed"
          };
        }
      );

      const claim = claimResult.snapshot.val();

      if (
        !claim ||
        String(claim.userId) !== String(user.id)
      ) {
        return res.status(409).json({
          success: false,
          error: "This ad task has already been claimed"
        });
      }

      /*
       * Separate Adexium progress path.
       * Old Monetag rewardProgress data is untouched.
       */

      const progressRef = db.ref(
        `users/${user.id}/adexiumRewardProgress`
      );

      const progressResult = await progressRef.transaction(
        current => {
          current = current || {};

          current.completed = Math.max(
            0,
            Number(current.completed) || 0
          );

          current.events = current.events || {};

          if (current.events[taskHash]) {
            return current;
          }

          current.events[taskHash] = true;
          current.completed += 1;
          current.updatedAt = Date.now();

          return current;
        }
      );

      if (!progressResult.committed) {
        return res.status(500).json({
          success: false,
          error: "Could not update reward progress"
        });
      }

      await claimRef.update({
        status: "credited",
        creditedAt: Date.now()
      });

      const latestUserSnap = await db
        .ref(`users/${user.id}`)
        .once("value");

      const latestUser = latestUserSnap.val() || {};

      const status = getRewardStatus(
        settings,
        latestUser
      );

      console.log(
        `Adexium reward credited: user=${user.id}, completed=${status.completed}`
      );

      return res.json({
        ...status,
        verified: true,
        message: status.unlocked
          ? "Reward unlocked"
          : "Ad successfully verified"
      });

    } catch (error) {
      console.error(
        "Adexium reward verification error:",
        error.message
      );

      res.status(500).json({
        success: false,
        error: "Could not verify Adexium reward"
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

        totalReferrals +=
          Number(user.totalReferrals) || 0;

        totalCredits +=
          Number(user.credits) || 0;
      });

      res.json({
        success: true,
        totalUsers: users.numChildren(),
        totalVideos: videos.numChildren(),
        totalReferrals,
        totalCredits
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
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

      /* Validate reward settings */

      if (updates.reward) {
        const currentSnap = await db
          .ref("settings/reward")
          .once("value");

        const current = {
          ...DEFAULT_SETTINGS.reward,
          ...(currentSnap.val() || {})
        };

        const incoming = updates.reward;

        const adsRequired =
          incoming.adsRequired !== undefined
            ? Number(incoming.adsRequired)
            : Number(current.adsRequired);

        const unlockMessage =
          incoming.unlockMessage !== undefined
            ? String(incoming.unlockMessage)
            : String(current.unlockMessage || "");

        const unlockUrl =
          incoming.unlockUrl !== undefined
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
              error: "Unlock URL must be a valid HTTP or HTTPS URL"
            });
          }
        }

        updates.reward = {
          ...current,
          ...incoming,
          enabled:
            incoming.enabled !== undefined
              ? !!incoming.enabled
              : !!current.enabled,
          adsRequired,
          unlockUrl,
          unlockMessage
        };
      }

      /* Validate referral settings */

      if (updates.referral) {
        const currentSnap = await db
          .ref("settings/referral")
          .once("value");

        const current = {
          ...DEFAULT_SETTINGS.referral,
          ...(currentSnap.val() || {})
        };

        const incoming = updates.referral;

        const reward =
          incoming.rewardPerReferral !== undefined
            ? Number(incoming.rewardPerReferral)
            : Number(current.rewardPerReferral);

        if (
          !Number.isFinite(reward) ||
          reward < 0 ||
          reward > 1000000
        ) {
          return res.status(400).json({
            success: false,
            error:
              "Referral reward must be between 0 and 1000000"
          });
        }

        updates.referral = {
          ...current,
          ...incoming,
          enabled:
            incoming.enabled !== undefined
              ? !!incoming.enabled
              : !!current.enabled,
          rewardPerReferral: reward
        };
      }

      /* Save Adexium settings only */

      if (updates.ads) {
        const currentSnap = await db
          .ref("settings/ads")
          .once("value");

        const current = currentSnap.val() || {};
        const incoming = updates.ads;

        const widgetId =
          incoming.adexiumWidgetId !== undefined
            ? String(incoming.adexiumWidgetId).trim()
            : String(
                current.adexiumWidgetId ||
                ADEXIUM_DEFAULT_WID
              );

        if (!widgetId || widgetId.length > 150) {
          return res.status(400).json({
            success: false,
            error: "Invalid Adexium Widget ID"
          });
        }

        const adsPerVideo =
          incoming.adsPerVideo !== undefined
            ? Number(incoming.adsPerVideo)
            : Number(current.adsPerVideo) ||
              DEFAULT_SETTINGS.ads.adsPerVideo;

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

        updates.ads = {
          adexiumEnabled:
            incoming.adexiumEnabled !== undefined
              ? incoming.adexiumEnabled === true ||
                incoming.adexiumEnabled === "true"
              : current.adexiumEnabled !== false,

          adexiumWidgetId: widgetId,
          adsPerVideo
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
      const snapshot = await db
        .ref("videos")
        .orderByChild("createdAt")
        .once("value");

      const videos = [];

      snapshot.forEach(child => {
        const video = child.val();

        if (video) {
          videos.push({
            id: child.key,
            ...video
          });
        }
      });

      videos.reverse();

      res.json({
        success: true,
        videos
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
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
          error:
            "Title, thumbnail and video URL are required"
        });
      }

      const videoRef = db.ref("videos").push();

      const video = {
        title: String(title).slice(0, 200),

        description:
          String(description || "").slice(0, 2000),

        thumbnail: String(thumbnail),
        videoUrl: String(videoUrl),

        categoryId:
          String(categoryId || "premium"),

        adsRequired: Math.max(
          1,
          Math.min(100, Number(adsRequired) || 2)
        ),

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
        console.error(
          "Notification error:",
          error.message
        );
      }

      res.json({
        success: true,
        videoId: videoRef.key,
        notifiedUsers,
        message: "Video added"
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

/* Notify users about new video */

async function notifyAllUsers(video) {
  const snapshot = await db.ref("users").once("value");
  const users = snapshot.val() || {};

  const botUsername = VIDEO_BOT_USERNAME.replace(/^@/, "");

  const deepLink = botUsername
    ? `https://t.me/${botUsername}?start=v_${video.id}`
    : WEB_APP_URL;

  const message =
    `🎬 নতুন ভিডিও যোগ করা হয়েছে!\n\n` +
    `📌 ${video.title}\n\n` +
    `ভিডিও দেখতে নিচের বাটনে ক্লিক করুন।`;

  const ids = Object.keys(users);

  for (let i = 0; i < ids.length; i += 20) {
    const batch = ids.slice(i, i + 20);

    await Promise.allSettled(
      batch.map(async id => {
        try {
          const buttons = deepLink
            ? [[
                {
                  text: "▶️ ভিডিও দেখুন",
                  url: deepLink
                }
              ]]
            : [];

          await telegramRequest("sendMessage", {
            chat_id: id,
            text: message,
            reply_markup: buttons.length
              ? { inline_keyboard: buttons }
              : undefined
          });
        } catch (error) {
          if (
            /blocked|chat not found|deactivated/i.test(
              error.message
            )
          ) {
            await db.ref(`users/${id}`).update({
              blocked: true
            });
          }
        }
      })
    );
  }

  return ids.length;
}

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

      const updates = {
        updatedAt: Date.now()
      };

      for (const key of allowed) {
        if (req.body[key] !== undefined) {
          updates[key] = req.body[key];
        }
      }

      if (updates.adsRequired !== undefined) {
        updates.adsRequired = Math.max(
          1,
          Math.min(100, Number(updates.adsRequired) || 1)
        );
      }

      await ref.update(updates);

      res.json({
        success: true,
        message: "Video updated"
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
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

      res.json({
        success: true,
        message: "Video deleted"
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
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
      const message = String(
        req.body.message || ""
      ).trim();

      if (!message || message.length > 4000) {
        return res.status(400).json({
          success: false,
          error:
            "Message is required (maximum 4000 characters)"
        });
      }

      const snapshot = await db
        .ref("users")
        .once("value");

      const users = snapshot.val() || {};
      const ids = Object.keys(users);

      let sent = 0;
      let failed = 0;

      for (let i = 0; i < ids.length; i += 20) {
        const batch = ids.slice(i, i + 20);

        const results = await Promise.allSettled(
          batch.map(id =>
            telegramRequest("sendMessage", {
              chat_id: id,
              text: message,
              disable_web_page_preview: false
            })
          )
        );

        results.forEach(result => {
          if (result.status === "fulfilled") {
            sent++;
          } else {
            failed++;
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
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
);

/* Telegram webhook */

app.post(
  "/api/telegram/webhook",
  async (req, res) => {
    if (
      WEBHOOK_SECRET &&
      req.get("x-telegram-bot-api-secret-token") !==
        WEBHOOK_SECRET
    ) {
      return res.sendStatus(403);
    }

    res.sendStatus(200);

    try {
      const message = req.body.message;

      if (
        !message ||
        !message.from ||
        !message.chat ||
        !firebaseReady
      ) {
        return;
      }

      const text = message.text || "";

      if (text.startsWith("/start")) {
        const payload = text.split(/\s+/)[1] || "";

        const saveResult = await saveTelegramUser(
          message.from,
          payload
        );

        const referralResult = await processReferral(
          message.from.id,
          payload,
          saveResult.isNewUser
        );

        if (referralResult.success) {
          await telegramRequest("sendMessage", {
            chat_id: message.chat.id,
            text:
              `🎉 অভিনন্দন!\n\n` +
              `তোমার Referral থেকে ` +
              `${referralResult.reward} Credit যোগ হয়েছে।`
          });
        }

        const botUsername =
          VIDEO_BOT_USERNAME.replace(/^@/, "");

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
          welcomeText +=
            `\n\n🔗 তোমার Referral Link:\n${referralLink}`;
        }

        await telegramRequest("sendMessage", {
          chat_id: message.chat.id,
          text: welcomeText,
          reply_markup: keyboard
        });
      }
    } catch (error) {
      console.error(
        "Webhook processing error:",
        error.message
      );
    }
  }
);

/* Setup Telegram webhook */

async function setupWebhook() {
  if (!BOT_TOKEN || !PUBLIC_URL || !WEBHOOK_SECRET) {
    console.log(
      "Webhook setup skipped: environment variables missing"
    );
    return;
  }

  try {
    const url =
      `${PUBLIC_URL.replace(/\/$/, "")}` +
      "/api/telegram/webhook";

    await telegramRequest("setWebhook", {
      url,
      secret_token: WEBHOOK_SECRET,
      allowed_updates: ["message"]
    });

    console.log("Telegram webhook configured");
  } catch (error) {
    console.error(
      "Webhook setup failed:",
      error.message
    );
  }
}

/* Home route */

app.get("/", (req, res) => {
  res.send("Premium Video Backend is running");
});

/* Start server */

app.listen(PORT, () => {
  console.log(
    `Premium Video server running on port ${PORT}`
  );

  setupWebhook();
});
