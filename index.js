const express = require("express");
const line = require("@line/bot-sdk");
const OpenAI = require("openai");
const fs = require("fs");
const path = require("path");

// ─────────────────────────────
// 環境変数から設定取得
// ─────────────────────────────
const config = {
  channelAccessToken: process.env.LINE_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// ─────────────────────────────
// セッション管理 & 長期メモリ
// ─────────────────────────────

// ユーザーごとのセッション（サーバーが動いている間）
const sessions = {}; // { [userId]: { stageIndex, turnsInStage, history: [...] } }

// ユーザーごとの長期プロフィール（ファイルに保存）
const PROFILE_FILE = path.join(__dirname, "userProfiles.json");
let userProfiles = {}; // { [userId]: { values:[], talents:[], likes:[], goals:[], vision:"", lastUpdated: "" } }

function loadProfiles() {
  try {
    if (fs.existsSync(PROFILE_FILE)) {
      const raw = fs.readFileSync(PROFILE_FILE, "utf8");
      userProfiles = JSON.parse(raw);
    }
  } catch (e) {
    console.error("Failed to load userProfiles.json:", e);
    userProfiles = {};
  }
}

function saveProfiles() {
  try {
    fs.writeFileSync(PROFILE_FILE, JSON.stringify(userProfiles, null, 2), "utf8");
  } catch (e) {
    console.error("Failed to save userProfiles.json:", e);
  }
}

function getOrCreateProfile(userId) {
  if (!userProfiles[userId]) {
    userProfiles[userId] = {
      values: [],
      talents: [],
      likes: [],
      goals: [],
      vision: "",
      lastUpdated: new Date().toISOString()
    };
  }
  return userProfiles[userId];
}

// 起動時にロード
loadProfiles();

// ─────────────────────────────
// セッションのステージ定義
// ─────────────────────────────
const STAGES = [
  {
    id: "values",
    name: "大事なこと（価値観）",
    maxTurns: 4,
    objective:
      "クライアントが『こう生きたい』『こんな状態でいたい』と思う価値観を言語化する。" +
      "幼少期の経験・尊敬する人・社会への違和感・本物の価値観（〜したい）にフォーカスする。"
  },
  {
    id: "talents",
    name: "得意なこと（才能）",
    maxTurns: 4,
    objective:
      "クライアントが『無意識にやってしまう』『やっていて心地よい』行動パターンを見つける。" +
      "充実体験・イラっとするポイント・周りに褒められること・成果の出し方から才能を探す。"
  },
  {
    id: "likes",
    name: "好きなこと（興味）",
    maxTurns: 4,
    objective:
      "クライアントが『なぜか気になる』『お金を払ってでも学びたい』と思う対象を探す。" +
      "本棚・勉強したいこと・救われた経験・怒りを感じる社会問題などから興味を掘る。"
  },
  {
    id: "want",
    name: "やりたいことの仮説",
    maxTurns: 3,
    objective:
      "これまで出てきた『好き × 得意』を組み合わせて、やりたいことの仮説をいくつか作る。" +
      "完璧を目指さず、『とりあえずこれで試してみたい』レベルでOKであると伝える。"
  },
  {
    id: "vision",
    name: "ライフビジョン",
    maxTurns: 3,
    objective:
      "制限を外して、5〜10年後の理想的な一日や生き方を具体的にイメージしてもらう。" +
      "『今の自分には無理そうだけど、想像するとワクワクする未来』を大きく描いてもらう。"
  },
  {
    id: "action",
    name: "最初の一歩",
    maxTurns: 2,
    objective:
      "ライフビジョンに少しでも近づくために、明日〜1週間以内にできる小さな行動を一緒に決める。" +
      "現実的で小さく、でも本人にとって意味がある一歩にする。"
  },
  {
    id: "summary",
    name: "まとめ・フィードバック",
    maxTurns: 1,
    objective:
      "これまでの対話を振り返り、『価値観・得意・好き・本当にやりたいこと・ライフビジョン・最初の一歩』を整理して言語化する。" +
      "同時に、内部的にはキーワードを抽出して長期メモリに保存する。"
  }
];

function getStage(session) {
  return STAGES[session.stageIndex] || STAGES[STAGES.length - 1];
}

// ─────────────────────────────
// コーチAIのベース SYSTEM プロンプト
// （さっき一緒に作った長いコンセプトをぎゅっと要約版）
// ─────────────────────────────
const BASE_SYSTEM_PROMPT = `
あなたはライフビジョン専門のプロフェッショナルコーチAIです。
クライアントが「今の自分には無理だと思うくらい大きなライフビジョン」を言語化できるよう、
質問と要約とフィードバックで伴走します。

・解説よりも「質問」「要約」「感情への共感」を優先してください。
・1メッセージは3〜6行程度＋最後に質問は1つだけにしてください。
・正解を押しつけず、クライアントの中にある価値観・才能・興味を引き出します。
・映画や科学などの知識説明は1〜2段落までにし、その後は必ず
  「あなた自身はそのテーマについてどう感じますか？」と本人に戻してください。
・全体のゴールは
  1) 大事なこと（価値観）
  2) 得意なこと（才能）
  3) 好きなこと（興味）
  4) 本当にやりたいことの仮説
  5) ライフビジョン（物語）
  6) 最初の一歩
  をクライアントと一緒に見つけることです。
`;

// ─────────────────────────────
// OpenAI 呼び出し：通常のコーチ対話
// ─────────────────────────────
async function callCoachModel({ stage, profile, history, userText }) {
  const stageInstruction = `
現在のステージ: ${stage.name} (${stage.id})

このステージの目的:
${stage.objective}

・このステージでは、このテーマに関する質問を中心に行ってください。
・ステージ内では必ず「相手の言葉の要約」→「そこから見える価値観/才能/興味の仮説」→「次の質問」
  の流れで対話します。
・ステージの後半（最後の1〜2ターン）では、そのステージで見えてきたポイントを簡単に整理し、
  次のステージで扱うテーマを軽く予告してください。
`;

  const memoryText = profile
    ? `
【このクライアントについて、これまで分かっている長期メモリ】

- 価値観（大事にしたいこと）: ${profile.values.join("、") || "まだ明確ではない"}
- 得意なこと（才能）: ${profile.talents.join("、") || "まだ明確ではない"}
- 好きなこと（興味のある分野）: ${profile.likes.join("、") || "まだ明確ではない"}
- 本当にやりたいことの仮説: ${profile.goals.join("、") || "未設定"}
- ライフビジョンのメモ: ${profile.vision || "未設定"}

この情報を参考にしつつ、今日の対話から新しい気づきがあれば、
さりげなくそれをフィードバックしてください。
`
    : "";

  const messages = [
    { role: "system", content: BASE_SYSTEM_PROMPT },
    { role: "system", content: stageInstruction },
    { role: "system", content: memoryText },
    // これまでの会話履歴を挿入
    ...history,
    { role: "user", content: userText }
  ];

  const completion = await openai.chat.completions.create({
    model: "gpt-4.1",
    messages
  });

  return completion.choices[0]?.message?.content?.trim() || "少し考えがまとまらなかったみたいです…もう一度教えてもらえますか？";
}

// ─────────────────────────────
// OpenAI 呼び出し：プロフィール抽出（内部用）
// ─────────────────────────────
async function extractProfileFromConversation(history) {
  // history は [{role, content}, ...]
  const analysisPrompt = `
あなたはコーチングの記録を分析するアシスタントです。
以下の会話履歴（コーチとクライアントの両方の発言を含む）から、
クライアントの特徴をJSON形式で抽出してください。

出力は必ず次の形式のJSON「だけ」にしてください。（説明文やコードブロックは禁止）

{
  "values": ["価値観1", "価値観2", ...],        // 生き方の価値観（自由、好奇心、安心、夢中などの1〜7個の名詞）
  "talents": ["才能1", "才能2", ...],            // 得意なこと・自然とやってしまうこと（1〜7個）
  "likes": ["興味分野1", "興味分野2", ...],      // 好きな分野・テーマ（1〜7個）
  "goals": ["本当にやりたいことの文章1", ...],  // 本当にやりたいことの候補（1〜3個）
  "vision": "5〜10年後のライフビジョンを1段落で要約した文章"
}

キーワードはすべて日本語で、短い名詞または短文にしてください。
`;

  const messages = [
    { role: "system", content: analysisPrompt },
    ...history
  ];

  const completion = await openai.chat.completions.create({
    model: "gpt-4.1",
    messages,
    temperature: 0.2
  });

  const text = completion.choices[0]?.message?.content || "{}";

  try {
    const json = JSON.parse(text);
    return json;
  } catch (e) {
    console.error("Failed to parse profile JSON:", text, e);
    return null;
  }
}

// ─────────────────────────────
// OpenAI 呼び出し：最終まとめメッセージ
// ─────────────────────────────
async function generateSummaryMessage(profile, history) {
  const summaryPrompt = `
あなたはライフビジョンコーチです。
これまでのコーチング対話の履歴と、内部的に整理されたプロフィール情報をもとに、
クライアントに渡す「今日のまとめメッセージ」を作ってください。

出力フォーマットは必ず次の構造にしてください（日本語）：

【今日見えた価値観（大事なこと）】
- 〜
- 〜

【得意なこと（才能）】
- 〜
- 〜

【好きなこと（興味）】
- 〜
- 〜

【本当にやりたいこと（仮説）】
- 〜

【ライフビジョン（未来の物語）】
（2〜4行で、5〜10年後の理想の一日や生き方を物語風に）

【最初の一歩（明日〜1週間以内）】
- ① 〜
- ② 〜（あれば）

【今日の振り返りの問い】
- 〜

箇条書きは見やすく、クライアントがスクリーンショットを撮って
何度も見返せるように、シンプルで優しい言葉でまとめてください。
`;

  const memoryBlock = `
【内部プロフィール情報】

- 価値観: ${profile.values.join("、") || "未設定"}
- 才能: ${profile.talents.join("、") || "未設定"}
- 好きなこと: ${profile.likes.join("、") || "未設定"}
- 本当にやりたいこと: ${profile.goals.join("、") || "未設定"}
- ライフビジョン（要約）: ${profile.vision || "未設定"}
`;

  const messages = [
    { role: "system", content: summaryPrompt },
    { role: "system", content: memoryBlock },
    ...history
  ];

  const completion = await openai.chat.completions.create({
    model: "gpt-4.1",
    messages
  });

  return completion.choices[0]?.message?.content?.trim() || "今日はたくさん話してくれてありがとうございました。これからも少しずつ、一緒にライフビジョンを育てていきましょう。";
}

// ─────────────────────────────
// Express + LINE Webhook
// ─────────────────────────────
const app = express();

app.post("/webhook", line.middleware(config), async (req, res) => {
  const client = new line.Client(config);
  const events = req.body.events;

  await Promise.all(
    events.map(async (event) => {
      if (event.type !== "message" || event.message.type !== "text") {
        return;
      }

      const userText = event.message.text;
      const userId = event.source.userId;

      // セッション取得 or 初期化
      if (!sessions[userId]) {
        sessions[userId] = {
          stageIndex: 0,
          turnsInStage: 0,
          history: [] // [{role, content}, ...]
        };
      }

      const session = sessions[userId];
      let stage = getStage(session);

      // プロフィール取得
      const profile = getOrCreateProfile(userId);

      let replyText = "";

      try {
        // summary ステージは特別扱い
        if (stage.id === "summary") {
          // 1) 会話履歴からプロフィール抽出・更新
          const extracted = await extractProfileFromConversation(session.history);
          if (extracted) {
            if (Array.isArray(extracted.values)) {
              profile.values = extracted.values;
            }
            if (Array.isArray(extracted.talents)) {
              profile.talents = extracted.talents;
            }
            if (Array.isArray(extracted.likes)) {
              profile.likes = extracted.likes;
            }
            if (Array.isArray(extracted.goals)) {
              profile.goals = extracted.goals;
            }
            if (typeof extracted.vision === "string") {
              profile.vision = extracted.vision;
            }
            profile.lastUpdated = new Date().toISOString();
            saveProfiles();
          }

          // 2) まとめメッセージ生成
          // 会話履歴 + プロフィールを渡す
          replyText = await generateSummaryMessage(profile, session.history);

          // summary なので、ステージ進行はここで止めてOK
        } else {
          // 通常ステージ：コーチモデルに投げる
          replyText = await callCoachModel({
            stage,
            profile,
            history: session.history,
            userText
          });

          // 履歴更新（ユーザー発言＆AI返答）
          session.history.push({ role: "user", content: userText });
          session.history.push({ role: "assistant", content: replyText });

          // 履歴が長くなりすぎないように制限
          if (session.history.length > 40) {
            session.history = session.history.slice(-40);
          }

          // ステージのターン数カウント & 進行
          session.turnsInStage += 1;

          if (session.turnsInStage >= stage.maxTurns) {
            session.stageIndex = Math.min(session.stageIndex + 1, STAGES.length - 1);
            session.turnsInStage = 0;
            stage = getStage(session); // 次のステージに更新

            // 次のステージ開始の軽い案内を、返答の最後に一行付け足す
            if (stage.id !== "summary") {
              replyText += `\n\n――\n次のステージでは「${stage.name}」について、一緒に深掘りしていきましょう。`;
            } else {
              replyText += `\n\n――\n次で、これまでの対話を振り返る「まとめ」のステージに入ります。`;
            }
          }
        }

        // LINE へ返信
        await client.replyMessage(event.replyToken, {
          type: "text",
          text: replyText
        });
      } catch (err) {
        console.error("Error in webhook handler:", err);

        // エラー時もユーザーにはメッセージを返す
        try {
          await client.replyMessage(event.replyToken, {
            type: "text",
            text:
              "ごめんね、内部でエラーが起きちゃったみたい…少し時間をおいて、もう一度話しかけてみてもらえる？"
          });
        } catch (e) {
          console.error("Failed to send error reply:", e);
        }
      }
    })
  );

  res.status(200).json({ status: "ok" });
});

// 起動
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("LifeVision Coach bot server running on port", port);
});
