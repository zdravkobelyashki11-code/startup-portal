import 'dotenv/config';
import app from './app.js';

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`\nStartup Portal backend is running`);
    console.log(`  Local URL: http://localhost:${PORT}`);
    console.log(`  Model: ${process.env.OPENAI_MODEL || 'gpt-5.2'}`);
    console.log(`  Database: ${process.env.DATABASE_URL ? 'configured' : 'missing DATABASE_URL'}`);
    console.log(`  Session secret: ${process.env.SESSION_SECRET ? 'configured' : 'missing SESSION_SECRET'}\n`);
});
