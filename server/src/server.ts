import dotenv from "dotenv";
import { app } from "./app";

dotenv.config();

const PORT = process.env.SERVER_PORT ? Number(process.env.SERVER_PORT) : 4000;

app.listen(PORT, () => {
  console.log(`Aris server listening on http://localhost:${PORT}`);
});
