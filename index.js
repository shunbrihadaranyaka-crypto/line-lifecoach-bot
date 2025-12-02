const express = require('express');
const line = require('@line/bot-sdk');
require('dotenv').config();

// LINEの設定
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET,
};

const app = express();

// LINEのミドルウェア（署名チェックなど）
app.post('/webhook', line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

// LINEクライアント
const client = new line.Client(config);

// イベントごとの処理
async function handleEvent(event) {
  // テキストメッセージ以外は無視
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  const userText = event.message.text;

  // ここで「エフィカシーを上げる返事」を作る
  const replyText = buildEfficacyReply(userText);

  // LINEに返信
  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: replyText,
  });
}

// ▼ エフィカシーを勝手に上げるロジック（シンプル版）
function buildEfficacyReply(userText) {
  const lowWords = ['無理', 'できない', '自信ない', 'ダメ', 'どうせ'];
  const hasLowWord = lowWords.some((w) => userText.includes(w));

  if (hasLowWord) {
    return (
      'その気持ちを正直に言葉にできている時点で、かなりレアな人です。\n\n' +
      `「${userText}」と感じている自分がいながらも、` +
      'それでも前に進もうとしている部分が、どこかに必ずあります。\n\n' +
      'もし「理想の自分」だったら、この状況をどう見て、どんな一歩を選ぶと思いますか？'
    );
  }

  // 通常パターン：ゴール側に意識を向ける質問
  return (
    'メッセージありがとうございます😊\n\n' +
    '今の話を聞いていて感じたのは、「まだまだ伸びしろしかないな」ということです。\n\n' +
    '・この先、どうなっていたら最高ですか？\n' +
    '・そのゴールに近づく「1ミリの行動」を、今日これからやるとしたら何にしますか？'
  );
}

// 動作確認用のルート
app.get('/', (req, res) => {
  res.send('Efficacy LINE Bot is running.');
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
