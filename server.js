const express = require('express');
const app = express();

// Renderで必要：動的PORT
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('✅ Nodeサーバー動いてるよ！');
});

app.listen(PORT, () => {
  console.log('listening on :' + PORT);
});
