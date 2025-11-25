const express = require("express");
const line = require("@line/bot-sdk");
const OpenAI = require("openai");

// ─────────────────────────────
// LINEの設定（Renderの環境変数から取る）
// ─────────────────────────────
const config = {
  channelAccessToken: process.env.LINE_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

// OpenAI クライアント
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// ─────────────────────────────
// セッション用の簡易メモリ（サーバーが動いている間だけ保持）
// ユーザーごとに直近の会話を覚えておく
// ─────────────────────────────
const sessions = {}; // { userId: [ { role, content }, ... ] }

// ─────────────────────────────
// コーチAIの人格・ルール（systemプロンプト）
// ─────────────────────────────
const SYSTEM_PROMPT = `
あなたはライフビジョン専門のプロフェッショナルコーチAIです。

# ミッション
クライアントが「今の自分には無理だと思うくらい大きなライフビジョン」を言語化できるように、
質問とフィードバックで伴走します。

# 振る舞い
- 解説よりも「質問」「要約」「感情への共感」を優先してください。
- 映画や科学の知識などを聞かれても、説明は1〜2段落にとどめ、
  すぐに「そのテーマについてクライアントが何を感じているか」「どんな未来を望んでいるか」に話を戻します。
- 1メッセージは3〜6行程度に収め、最後に必ず1つだけ質問をします。
- 「価値観・感情・憧れ・大切にしたいもの・理想の一日」にフォーカスして対話してください。
- クライアントの言葉を短く要約して返しながら、「つまり〜ということですね」と鏡のように整理します。

# 禁止事項
- 豆知識や長い解説を中心にした回答。
- 正解を押しつけるアドバイス。
- クライアントの可能性を小さく見積もる言い方。
`;

// ─────────────────────────────
// Express アプリ
// ─────────────────────────────
const app = express();

// LINEのWebhookエンドポイント
app.post("/webhook", line.middleware(config), async (req, res) => {
  const client = new line.Client(config);
  const events = req.body.events;

  await Promise.all(
    events.map(async (event) => {
      // テキストメッセージ以外は無視
      if (event.type !== "message" || event.message.type !== "text") {
        return;
      }

      const userText = event.message.text;
      const userId = event.source.userId;

      // このユーザー用の履歴がなければ作る
      if (!sessions[userId]) {
        sessions[userId] = [];
      }

      // これまでの履歴 + 今回の発言をまとめてモデルに渡す
      const messages = [
        { role: "system", content: SYSTEM_PROMPT },
        ...sessions[userId],
        { role: "user", content: userText }
      ];

      try {
        const completion = await openai.chat.completions.create({
          // ※ここでモデルを gpt-4.1 に格上げ
          model: "gpt-4.1",
          messages
        });

        const replyText =
          completion.choices[0]?.message?.content ||
          "ちょっと上手く返答できなかったみたい…もう一度教えてくれる？";

        // 履歴を更新（最後の10メッセージ分だけ残す）
        sessions[userId].push({ role: "user", content: userText });
        sessions[userId].push({ role: "assistant", content: replyText });
        if (sessions[userId].length > 10) {
          sessions[userId] = sessions[userId].slice(-10);
        }

        // LINEに返信
        await client.replyMessage(event.replyToken, {
          type: "text",
          text: replyText
        });
      } catch (err) {
        console.error("OpenAI or LINE reply error:", err);

        // エラー時もユーザーには何か返す
        try {
          await client.replyMessage(event.replyToken, {
            type: "text",
            text:
              "ごめんね、内部でエラーが起きちゃったみたい…少し時間をおいてもう一度試してみて！"
          });
        } catch (e) {
          console.error("Failed to send error message to user:", e);
        }
      }
    })
  );

  // LINE側に「受け取ったよ」と返す
  res.status(200).json({ status: "ok" });
});

// Render用：PORTがあればそれを使う
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("Server running on port", port);
});
