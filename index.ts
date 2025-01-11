import axios, { AxiosError } from "axios";
import fs from "fs";

const DEBUG = false;
const DEBUG_PROMPTS = false;
const MAX_ROUNDS = 25;
const CONCURRENT_PROMPTS = true; // i don't think this causes more draws but it's worth exploring
const MODEL = "llama3.3:latest";

const extraStrategyLine =
  //"Play unpredictably to avoid patterns, but actively analyze and exploit opponents’ behavioral tendencies to counter their predictable moves. Adapt dynamically by recognizing if the opponent is using strategies and counter-strategies, and shift between randomness and pattern exploitation accordingly.";
  ""; // the more you write here the longer the games take so it's a trade off

const totalScore = {
  alice: 0,
  bob: 0,
  draw: 0,
};

async function sendToModel(prompt: string): Promise<string> {
  //requires a local version of 'ollama serve' running
  //please someone make it work with GPT as an option instead
  const response = await axios.post("http://localhost:11434/api/generate", {
    model: MODEL,
    prompt: prompt,
    stream: false,
  });
  return response.data.response;
}

async function generatePrompt(
  playerName: string,
  opponentName: string,
  personality: string,
  historyTalk: string
): Promise<{ action: "rock" | "paper" | "scissors" }> {
  const prompt = `
    you are ${playerName} and you are playing a game of rock paper scissors with ${opponentName}
    ${personality}
    ${historyTalk}
    ${extraStrategyLine}
    please only respond with exact JSON (in the format {"action": string}) and no other text
  `;

  if (DEBUG_PROMPTS) {
    console.log(
      `\n-------------\n${playerName} Prompt:\n`,
      prompt,
      "\n-------------\n"
    );
  }

  const response = await sendToModel(prompt);

  try {
    const action = JSON.parse(response);
    if (!["rock", "paper", "scissors"].includes(action.action)) {
      throw new Error(`Invalid action received: ${action.action}`);
    }
    return action;
  } catch (error) {
    console.error(`Error parsing ${playerName}'s response:`, error);
    throw error;
  }
}

async function playRound(): Promise<void> {
  const loadedHistory = fs.readFileSync("history.txt", "utf8");

  let historyTalk =
    loadedHistory.length > 0
      ? `here is the history of actions:\n\n${loadedHistory}\n\nuse this history to make sure you don't repeat a pattern of actions that can be guessed`
      : "(there is no history of actions yet, this is the first move, open with a random move no one can guess)";

  if (DEBUG) {
    console.log("historyTalk:", historyTalk);
  }

  const alicePersonality =
    //"you are a ruthless and cunning player and you will always win";
    "";
  const bobPersonality =
    //"you know alice is a ruthless and cunning player so you have to be careful";
    "";

  let aliceAction;
  let bobAction;

  if (CONCURRENT_PROMPTS) {
    [aliceAction, bobAction] = await Promise.all([
      generatePrompt("alice", "bob", alicePersonality, historyTalk),
      generatePrompt("bob", "alice", bobPersonality, historyTalk),
    ]);
  } else {
    aliceAction = await generatePrompt(
      "alice",
      "bob",
      alicePersonality,
      historyTalk
    );
    bobAction = await generatePrompt(
      "bob",
      "alice",
      bobPersonality,
      historyTalk
    );
  }

  if (DEBUG) {
    console.log("aliceAction:", aliceAction);
    console.log("bobAction:", bobAction);
  }

  const timestamp = new Date().toISOString();
  const result = determineWinner(aliceAction.action, bobAction.action);

  if (result === "alice wins") {
    totalScore.alice++;
  } else if (result === "bob wins") {
    totalScore.bob++;
  } else {
    totalScore.draw++;
  }

  const emojiMap: { [key in "rock" | "paper" | "scissors"]: string } = {
    rock: "✊",
    paper: "✋",
    scissors: "✌️",
  };

  const resultText = `${timestamp} - Alice: ${aliceAction.action} ${
    emojiMap[aliceAction.action]
  } - Bob: ${bobAction.action} ${
    emojiMap[bobAction.action]
  } - Result: ${result}\n`;

  if (DEBUG) {
    console.log("Total Score:", totalScore);
  }

  fs.appendFileSync("history.txt", resultText);

  console.log(
    "🤖 Alice throws ",
    aliceAction.action,
    emojiMap[aliceAction.action],
    " 🤖 Bob throws ",
    bobAction.action,
    emojiMap[bobAction.action],
    " 🎉 Result: ",
    result
  );
}

async function run(): Promise<void> {
  try {
    while (true) {
      const startTime = Date.now();

      for (let i = 0; i < MAX_ROUNDS; i++) {
        await playRound();
      }

      const endTime = Date.now();
      const totalTime = (endTime - startTime) / 1000;

      console.log("🏆 Final Score:", totalScore);
      console.log("🔄 Total Rounds:", MAX_ROUNDS);
      console.log("🎯 Alice Wins:", totalScore.alice);
      console.log("🎯 Bob Wins:", totalScore.bob);
      console.log("🤝 Draws:", totalScore.draw);
      console.log("⏱️ Total Time Taken:", totalTime, "seconds");

      if (totalScore.draw > (MAX_ROUNDS / 3) * 1.05) {
        console.log(
          "⚠️ Too many draws, the model is repeating itself, needs entropy\n\n"
        );
      }

      totalScore.alice = 0;
      totalScore.bob = 0;
      totalScore.draw = 0;

      fs.writeFileSync("history.txt", "");
    }
  } catch (error) {
    if (error instanceof AxiosError) {
      console.error("Error communicating with Ollama:", error.message);
    } else {
      console.error("Unexpected error:", error);
    }
  }
}

function determineWinner(aliceAction: string, bobAction: string): string {
  if (aliceAction === bobAction) return "draw";
  if (
    (aliceAction === "rock" && bobAction === "scissors") ||
    (aliceAction === "scissors" && bobAction === "paper") ||
    (aliceAction === "paper" && bobAction === "rock")
  ) {
    return "alice wins";
  }
  return "bob wins";
}

try {
  fs.writeFileSync("history.txt", "");
  run();
} catch (error) {
  console.error("Error setting up history file:", error);
}
