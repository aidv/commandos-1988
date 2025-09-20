# Commandos - Behind Enemy Lines (1998) - Packer / Unpacker

I wanted to see if I could upgrade the gaming experience of this old PC game by using AI for both the game audio and game graphics.

I used AI to improve the audio quality of the game audio files, and I also used AI to upgrade the graphics files of the game.

## How to use

1. Add the `WARGAME.DIR` file to the root of this project
2. Run `unpack.js` to unpack the file
3. Modify files as you wish
4. Run `pack.js` to pack the file
5. Copy `WARGAME_NEW.DIR` to the root of the game installation folder (and obviously rename it to `WARGAME.DIR`)

## What I learned
- The file and folder entries inside `WARGAME.DIR` must be upper-case
- The game supports 44.1kHz audio files
- The `.RLE` files need to be patched for some reason.

## How did I do it?
I mostly used "ChatGPT 5 Thinking".
It failed to extract any meaningful data in the beginning because I was looking inside the wrong file,
but eventually I figured out manually what the correct data structure was for `WARGAME.DIR` and I guided ChatGPT to write a script for me.

[Read the entire conversation here](https://chatgpt.com/share/68ce869f-442c-8006-a564-0a8ce6123785)

## TODO (???)

## Decode `.RLE` files
When opening these files in IrfanView, they look skewed. I don't know what's going on here. I might need to open the game executable and do some reverse engineering.

UPDATE 20-09-2025: [I found an existing project called "Commandos Modding"](https://sites.google.com/site/commandosmod/downloads) which is quite extensive that has pretty much everything that is needed. 

I used ChatGPT to port the RLE-to-BMP class to a NodeJS script.