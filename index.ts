import axios, { AxiosError } from "axios";
import fs from "fs";
import path from "path";

const DEBUG_PROMPTS = false;
const MAX_ROUNDS = 25;
const CONCURRENT_PROMPTS = false;
const MODEL = "llama3.3:latest";
const BASE_WIDGET_PRICE = 100;
const PRICE_VOLATILITY = 0.15; // 15% max price movement per round

interface PlayerState {
  credits: number;
  widgets: number;
  history: AgentHistory[];
}

interface Agent {
  name: string;
  personality: string;
  initialState: PlayerState;
}

interface GameState {
  currentPrice: number;
  agents: Map<string, PlayerState>;
  round: number;
}

interface AgentHistory {
  action: "buy" | "sell" | "hold";
  amount: number;
  price: number;
  round: number;
}

// Load all agents from the agents directory
function loadAgents(): Agent[] {
  const agentsDir = path.join(process.cwd(), "agents");
  const agentFiles = fs
    .readdirSync(agentsDir)
    .filter((file) => file.endsWith(".json"));

  return agentFiles.map((file) => {
    const agentData = fs.readFileSync(path.join(agentsDir, file), "utf8");
    return JSON.parse(agentData) as Agent;
  });
}

// Initialize game state with loaded agents
function initializeGameState(): GameState {
  const agents = loadAgents();
  const agentStates = new Map<string, PlayerState>();

  agents.forEach((agent) => {
    agentStates.set(agent.name, {
      ...agent.initialState,
      history: [],
    });
  });

  return {
    currentPrice: BASE_WIDGET_PRICE,
    agents: agentStates,
    round: 0,
  };
}

const gameState: GameState = initializeGameState();

function updatePrice(): number {
  const maxMove = gameState.currentPrice * PRICE_VOLATILITY;
  const priceMove = (Math.random() * 2 - 1) * maxMove;
  gameState.currentPrice = Math.max(1, gameState.currentPrice + priceMove);
  return gameState.currentPrice;
}

function calculateNetWorth(player: PlayerState, currentPrice: number): number {
  return player.credits + player.widgets * currentPrice;
}

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
  state: PlayerState,
  currentPrice: number,
  historyTalk: string
): Promise<{ action: "buy" | "sell" | "hold"; amount: number }> {
  // Calculate price trend from recent history
  const priceHistory = state.history.map((h) => h.price);
  const priceChange =
    priceHistory.length >= 2
      ? (((currentPrice - priceHistory[0]) / priceHistory[0]) * 100).toFixed(1)
      : "0";

  const averagePrice =
    priceHistory.length > 0
      ? (priceHistory.reduce((a, b) => a + b, 0) / priceHistory.length).toFixed(
          2
        )
      : currentPrice.toFixed(2);

  const recentHistory = state.history
    .slice(-5)
    .map(
      (h) =>
        `Round ${h.round}: ${h.action} ${h.amount} widgets at ${h.price.toFixed(
          2
        )} credits`
    )
    .join("\n");

  const prompt = `
    You are ${playerName}, a widget trader in a competitive market with multiple traders.
    Your current status:
    - You have ${state.credits.toFixed(2)} credits available
    - You own ${state.widgets} widgets
    - The current market price is ${currentPrice.toFixed(2)} credits per widget
    - Price change since start: ${priceChange}%
    - Average historical price: ${averagePrice}
    - This is round ${gameState.round} of ${MAX_ROUNDS}
    
    Your recent trading history:
    ${recentHistory || "No previous trades"}
    
    ${personality}
    
    IMPORTANT: You must respond with ONLY a JSON object in this exact format:
    For buying: {"action": "buy", "amount": 5}
    For selling: {"action": "sell", "amount": 3}
    For holding: {"action": "hold", "amount": 0}
    
    Rules:
    - Response must be valid JSON
    - No explanation text, ONLY the JSON object
    - action must be exactly "buy", "sell", or "hold"
    - amount must be a number (use 0 for hold)
    - For buying: amount * current_price must not exceed your available credits
    - For selling: amount must not exceed your owned widgets
    - Consider price trends before making large purchases
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
    if (!["buy", "sell", "hold"].includes(action.action)) {
      throw new Error(`Invalid action received: ${action.action}`);
    }
    if (typeof action.amount !== "number" || action.amount < 0) {
      throw new Error(`Invalid amount: ${action.amount}`);
    }
    if (action.action === "hold" && action.amount !== 0) {
      action.amount = 0; // Force amount to 0 for hold actions
    }

    // Validate trade is within means
    if (action.action === "buy") {
      const cost = action.amount * currentPrice;
      if (cost > state.credits) {
        console.log(
          `⚠️ ${playerName} attempted to buy ${
            action.amount
          } widgets for ${cost.toFixed(
            2
          )} credits but only has ${state.credits.toFixed(2)} available`
        );
        return { action: "hold", amount: 0 };
      }
    } else if (action.action === "sell" && action.amount > state.widgets) {
      console.log(
        `⚠️ ${playerName} attempted to sell ${action.amount} widgets but only has ${state.widgets}`
      );
      return { action: "hold", amount: 0 };
    }

    return action;
  } catch (error) {
    console.error(`Error parsing ${playerName}'s response:`, error);
    throw error;
  }
}

// Add new function for the Dungeon Master's narration
async function getDungeonMasterNarration(
  oldPrice: number,
  newPrice: number,
  gameState: GameState
): Promise<string> {
  const percentChange = ((newPrice - oldPrice) / oldPrice) * 100;
  const direction = newPrice > oldPrice ? "increased" : "decreased";

  // Format the history of all agents
  const allTraderHistory = Array.from(gameState.agents.entries())
    .map(([name, state]) => {
      const recentMoves = state.history
        .slice(-3) // Last 3 moves for each trader
        .map(
          (h) =>
            `Round ${h.round}: ${h.action} ${
              h.amount
            } widgets at ${h.price.toFixed(2)} credits`
        )
        .join("\n");
      return `${name}:\n${recentMoves}`;
    })
    .join("\n\n");

  const prompt = `
    You are a Dungeon Master narrating the widget market in a fantasy trading world.
    The widget price has ${direction} from $${oldPrice.toFixed(
    2
  )} to $${newPrice.toFixed(2)} credits (${Math.abs(percentChange).toFixed(
    1
  )}% change).

    Current Round: ${gameState.round} of ${MAX_ROUNDS}

    Recent Market History:
    ${allTraderHistory}
    (the number in parenthesis is each agent's net worth)

    If there is no market histopry: kick us off with a one or two liner making something up about how these widgets are cool and we are going to trade them. 
    If there is market history: First, talk through how the players are doing if there is a history or purchases.
    Most importantly, If there is market history: let's talk about the market for widgets and how/why it has changed in the way it has according to all historical lore above.
    Consider the traders' recent actions in your narrative.
    Be creative but concise it doesn't need to be all fantasy like, just tell us what is going on.
    Response should be plain text, no quotes or formatting.
  `;

  return await sendToModel(prompt);
}

// Modify the playRound function to include the narration
async function playRound(): Promise<void> {
  console.log("\n-------------\n");
  gameState.round++;
  const oldPrice = gameState.currentPrice;
  updatePrice();

  // Get and display the Dungeon Master's narration with full context
  const narration = await getDungeonMasterNarration(
    oldPrice,
    gameState.currentPrice,
    gameState
  );
  console.log(`\n💬 ${narration}`);

  const agents = loadAgents();
  let agentActions = [];

  if (CONCURRENT_PROMPTS) {
    const agentPromises = agents.map((agent) =>
      generatePrompt(
        agent.name,
        "others",
        agent.personality,
        gameState.agents.get(agent.name)!,
        gameState.currentPrice,
        ""
      )
    );
    agentActions = await Promise.all(agentPromises);
  } else {
    for (const agent of agents) {
      const action = await generatePrompt(
        agent.name,
        "others",
        agent.personality,
        gameState.agents.get(agent.name)!,
        gameState.currentPrice,
        ""
      );
      agentActions.push(action);
    }
  }

  // Process all trades
  agents.forEach((agent, index) => {
    const action = agentActions[index];
    const agentState = gameState.agents.get(agent.name)!;

    if (action.action === "buy") {
      const cost = action.amount * gameState.currentPrice;
      if (cost <= agentState.credits) {
        agentState.credits -= cost;
        agentState.widgets += action.amount;
      } else {
        console.log(
          `🚫 Rejected ${agent.name}'s buy of ${action.amount} widgets - insufficient credits`
        );
      }
    } else if (action.action === "sell") {
      const proceeds = action.amount * gameState.currentPrice;
      if (action.amount <= agentState.widgets) {
        agentState.credits += proceeds;
        agentState.widgets -= action.amount;
      } else {
        console.log(
          `🚫 Rejected ${agent.name}'s sale of ${action.amount} widgets - insufficient widgets`
        );
      }
    }

    agentState.history.push({
      action: action.action,
      amount: action.amount,
      price: gameState.currentPrice,
      round: gameState.round,
    });
  });

  // Log round results
  const timestamp = new Date().toISOString();
  const actionEmoji = {
    buy: "🟢",
    sell: "🔴",

    hold: "⚪",
  };

  let resultText = `\n\n⚙️  Widgets: $${gameState.currentPrice.toFixed(
    2
  )} credits\n\n📊 Round ${gameState.round}`;

  agents.forEach((agent, index) => {
    const agentState = gameState.agents.get(agent.name)!;
    const action = agentActions[index];
    const netWorth = calculateNetWorth(agentState, gameState.currentPrice);

    resultText += ` | ${agent.name}: ${actionEmoji[action.action]} ${
      action.action === "hold" ? "hold" : `${action.action} ${action.amount}`
    } (${agentState.widgets}) ($${agentState.credits.toFixed(
      2
    )}) [$${netWorth.toFixed(2)}]`;
  });

  resultText += "\n";

  console.log(resultText);
}

async function run(): Promise<void> {
  try {
    const startTime = Date.now();

    console.log("\n --- Agents --- \n");
    const agents = loadAgents();
    agents.forEach((agent) => {
      console.log(`${agent.name}: ${agent.personality}\n`);
    });

    for (let i = 0; i < MAX_ROUNDS; i++) {
      await playRound();
    }

    const endTime = Date.now();
    const totalTime = (endTime - startTime) / 1000;

    console.log("\n🏆 Final Results:");

    const finalResults = agents.map((agent) => {
      const agentState = gameState.agents.get(agent.name)!;
      const netWorth = calculateNetWorth(agentState, gameState.currentPrice);
      return { name: agent.name, worth: netWorth };
    });

    finalResults.forEach((result) => {
      console.log(`${result.name}'s Net Worth: $${result.worth.toFixed(2)}`);
    });

    // Determine the winner
    const winner = finalResults.reduce((prev, current) =>
      prev.worth > current.worth ? prev : current
    );

    console.log(`Winner: ${winner.name}`);
    console.log(`⏱️ Total Time: ${totalTime} seconds`);

    // Reset game state
    const freshState = initializeGameState();
    Object.assign(gameState, freshState);
  } catch (error) {
    if (error instanceof AxiosError) {
      console.error("Error communicating with Ollama:", error.message);
    } else {
      console.error("Unexpected error:", error);
    }
  }
}

try {
  console.log("\n --- Traders' Delight: a widget marketplace -- \n");
  run();
} catch (error) {
  console.error("Unexpected error:", error);
}
