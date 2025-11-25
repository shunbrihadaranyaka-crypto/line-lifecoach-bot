const express = require("express");
const line = require("@line/bot-sdk");
const OpenAI = require("openai");

const config = {
  channelAccessToken: process.env.LINE_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const app = express();

// LINEのWebhookエンドポイント
app.post("/webhook", line.middleware(config), async (req, res) => {
  const client = new line.Client(config);
  const events = req.body.events;

  // 複数イベントが来ることがあるので map で処理
  await Promise.all(
    events.map(async (event) => {
      // テキストメッセージ以外は無視
      if (event.type !== "message" || event.message.type !== "text") {
        return;
      }

      const userText = event.message.text;

      // ChatGPTに投げる
      const completion = await openai.chat.completions.create({
        model: "gpt-4.1-mini",
        messages: [
          {
            role: "system",
            content: "あなたはライフビジョン専門のやさしいコーチAIです。相手の話をよく聞きながら、質問をしつつ、相手の本音や望んでいる未来を引き出すように対話してください。"
          },
          { role: "user", content: userText }
        ]
      });

      const replyText =
        completion.choices[0]?.message?.content ||
        "ごめんね、ちょっと上手く答えが出てこなかった…もう一度教えてもらえる？";

      // LINEに返信
      await client.replyMessage(event.replyToken, {
        type: "text",
        text: replyText
      });
    })
  );

  // LINE側に「受け取ったよ」と返す
  res.status(200).json({ status: "ok" });
});

// Renderなどの環境では PORT という変数が渡されるので、それを優先
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("Server running on port", port);
});
