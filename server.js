import { createApp } from './src/app.js';

const port = Number(process.env.PORT || 3000);
const { app } = createApp();

app.listen(port, () => {
  console.log(`baggage workbench listening on http://localhost:${port}`);
});
