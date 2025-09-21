# Commandos - Behind Enemy Lines (1998) - Packer / Unpacker

I wanted to see if I could upgrade the gaming experience of this old PC game by using AI for both the game audio and game graphics.

I used AI to improve the audio quality of the game audio files, and I also used AI to upgrade the graphics files of the game.

## How to use

1. Add the `WARGAME.DIR` file to the root of this project
2. Run `unpack.js` to unpack the file
3. Run `rle2bmp.js` to unpack all `.RLE` files
4. Run `infoBuilder.js` to generate a database of original image sizes
5. Modify files as you wish, e.g edit or replace audio files, edit BMP's, etc
6. Run `imgEnsurer.js` to ensure that all images have the correct formats for the game. It basically converts files into their correct formats, so you can freely drop e.g a 24-Bit BMP and this script will convert it to an 8-bit BMP with the original image size.
7. Run `bmp2rle.js` to re-pack all `.RLE` files
8. Run `pack.js` to re-pack. The output file is `WARGAME_REPACKED.DIR`
9. Copy `WARGAME_REPACKED.DIR` to the root of the game installation folder (and obviously rename it to `WARGAME.DIR`)

## What I learned
- The file and folder entries inside `WARGAME.DIR` must be upper-case
- The game supports 44.1kHz audio files
- The `.RLE` files seem to have a slightly different format than what most `.RLE` compatible software expect.
- BMPs can have different sizes than the original BMPs, but they will not render within their intended bounds.
- BMPs **must** be 256 colors (8-bit), or they won't render

## How did I do it?
I mostly used "ChatGPT 5 Thinking".

It failed to extract any meaningful data in the beginning because I was looking inside the wrong file, but eventually I figured out manually what the correct
data structure was for `WARGAME.DIR` and I guided ChatGPT to write a script for me.

**UPDATE 20-09-2025**: [I found an existing project called "Commandos Modding"](https://sites.google.com/site/commandosmod/downloads) which is quite extensive that has pretty much everything that is needed. 

I used ChatGPT to port the RLE-to-BMP class to a NodeJS script. It wasn't straight forward and I still needed to manually analyze the code and guide ChatGPT, but eventually it did figure it out.

## TODO (???)

Tons of stuff.