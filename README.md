# Presentation Buddy - AI-Powered Stream Production Assistant

Presentation Buddy is an OBS control system that uses Claude AI to automate streaming production, allowing solo creators to focus on content delivery rather than technical management.

## Technical Overview

This implementation uses:

- **OBS Studio**: Industry-standard streaming software
- **TypeScript-based MCP Server**: A lightweight relay service connecting Claude AI to OBS
- **Claude AI**: For natural language understanding and production decision making
- **OBS WebSocket API**: For direct control of scene switching, overlays, and media elements
- **Local Processing**: All functionality runs on the presenter's machine for minimal latency

### Key Components

- **MCP Server**: A middleware that translates Claude's decisions into OBS WebSocket commands
- **Scene Management**: Automated switching based on content and verbal cues
- **Media Controls**: Intelligent handling of overlays, captions, and picture-in-picture elements
- **Voice Response**: Text-to-speech capabilities for AI responses during presentations

### Implementation

The server establishes a WebSocket connection with OBS and exposes an API that Claude can access. When Claude identifies a production need from the presenter's speech or on-screen content, it sends commands through the MCP server to control OBS in real-time.

## Inspiration

Going live alone is hard.  
While talking, you're expected to change camera angles, show slides, add captions, and keep viewers engaged—all at once. We wanted a buddy who could handle the production booth, so every solo creator can focus on the story, not the buttons.

## What it does

**Presentation Buddy** is an AI-powered sidekick for streamers and presenters.  
It listens to what's happening on screen and behind the mic, then:

* Switches scenes at the perfect moment  
* Pops up captions, graphics, or picture-in-picture window automatically  
* Even delivers short voice-overs when you need a break  

Think of it as a tiny producer that never gets tired.

## How we built it

* Claude AI listens for cues.  
* A lightweight relay sends those cues to OBS Studio, the most popular live-stream tool.  
* OBS takes the commands—"change camera," "show caption," "start replay"—and makes the magic happen.  
* A sprinkle of text-to-speech gives the AI its own voice.

All of this runs locally, so there's no cloud delay or fancy hardware.

## Challenges we ran into

* Build a MCP server wrapping the native OBS APIs
* Real-time speech response time
* Good plot that Claude follows well
* We could not make it providing screenshot to claude via MCP

## Accomplishments that we're proud of

* A live demo that goes from title slide to dynamic content with **zero human clicks**.  
* Turned a one-person setup into a stress-free broadcast.  

## What we learned

* How to build and configure MCP on Claude and Cursor

## What's next for Presentation Buddy

1. **Viewer interactivity** – let chat votes trigger overlays and polls.  
2. **One-click installer** – so any streamer can meet their new Buddy in minutes.

*From solo streamer to studio pro, instantly.*

## Installation & Setup

1. Clone this repository
2. Install dependencies with `npm install`
3. Configure OBS WebSocket connection settings
4. Start the MCP server with `npm start`
5. Connect your Claude AI instance to the MCP server
6. Start your OBS session and let Presentation Buddy take control

## Claude MCP Configuration

To set up Claude with Presentation Buddy, you'll need to configure the MCP (Machine Control Protocol) settings in Cursor or another Claude interface. This allows Claude to control OBS through our server.

### Claude MCP Config

Add the following configuration to your Claude settings:

```json
{
  "mcpServers": {
    "obs-mcp-ts": {
      "type": "stdio",
      "command": "/path/to/your/node",
      "args": [
        "/path/to/obs-mcp-server-ts/build/index.js"
      ],
      "toolNamespaces": ["obs-mcp-ts"]
    },
    "tts-mcp": {
      "command": "npx",
      "args": [
        "-p", "tts-mcp",
        "tts-mcp-server",
        "--voice", "nova",
        "--model", "gpt-4o-mini-tts"
      ],
      "env": {
        "OPENAI_API_KEY": "Your-API-Key"
      }
    }
  },

  "toolPermissions": {
    "obs-mcp-ts": true,
    "tts-mcp": true
  }
}
```

Replace the paths with your actual Node.js and server paths:
- `/path/to/your/node` - Path to your Node.js executable (e.g., `/Users/username/.nvm/versions/node/v20.17.0/bin/node`)
- `/path/to/obs-mcp-server-ts/build/index.js` - Path to the built server JavaScript file

For the TTS-MCP configuration, be sure to:
1. Insert your actual OpenAI API key
2. Choose your preferred voice (default: nova)
3. Select the appropriate model for text-to-speech (default: gpt-4o-mini-tts)

### OBS Setup

1. Install OBS Studio (version 28+ recommended)
2. Enable the WebSocket server in OBS:
   - Go to Tools → WebSocket Server Settings
   - Enable the WebSocket server
   - Set a port (default: 4455)
   - Configure authentication if needed

3. Create your scenes in OBS:
   - Main Camera
   - Presentation/Slides
   - Picture-in-Picture
   - Any additional scenes you want Claude to control

### Testing the Connection

Once configured:
1. Start OBS Studio
2. Run the MCP server (`npm start`)
3. Open Claude with MCP configured
4. Test a simple command like switching scenes

## License

This project is available under the MIT License.
