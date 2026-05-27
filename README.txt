![Folio](https://github.com/Velvet-Horizon-Studio/Folio/blob/main/Folio.png?raw=true)
FOLIO  v.1.0.0
Your images, beautifully kept.

Folio is a lightweight Windows desktop application built for people who work
with large image collections. Whether you are curating AI-generated artwork,
reviewing a photography shoot, or simply browsing years of saved pictures,
Folio gives you a clean, fast, and distraction-free environment to view,
organise, and manage your files — without touching a file manager.

It was designed with one principle in mind: stay out of the way and let the
images speak for themselves.


--------------------------------------------------------------------------------
  FEATURES
--------------------------------------------------------------------------------

  SLIDESHOW VIEWER
  ----------------
  Load images from one or more folders and let Folio run them as a continuous
  slideshow. Choose from multiple transition effects (fade, slide, zoom) and
  dial in the exact speed you want. The viewer fills your screen edge to edge,
  and in fullscreen mode the controls quietly disappear after a few seconds of
  inactivity so nothing competes with the image.

  Use the left and right arrow keys to step through images manually at any time,
  or press Space to pause and resume the automatic slideshow. Double-click any
  image to toggle fullscreen instantly. Right-click to snap the zoom back to
  100 % centered whenever you need a clean starting point.

  THUMBNAIL BROWSER
  -----------------
  A collapsible sidebar shows every image as a thumbnail, grouped by folder.
  The grid is lazy-loaded — thumbnails are generated on demand and cached to
  disk, so the second time you open a folder they appear immediately without
  any waiting. You can resize the sidebar and adjust thumbnail size with a
  slider at the bottom of the panel. The active image is always highlighted
  and kept in view as the slideshow advances.

  Click any thumbnail to jump straight to that image in the viewer. Ctrl-click
  to build a multi-selection for bulk operations.

  ZOOM AND PAN
  ------------
  Scroll the mouse wheel over any image to zoom in or out smoothly between
  25 % and 500 %. The Arrow Up and Down keys do the same thing from the
  keyboard. Once zoomed in, click and drag to pan around the image freely.
  Right-clicking at any time resets both zoom and position back to
  100 % centered.

  LIVE FOLDER WATCHING
  --------------------
  Add a folder and Folio keeps watching it in the background. The moment an
  image file is added, moved, or removed from any watched folder, the
  thumbnail grid updates automatically — no manual refresh, no restart needed.
  This makes Folio a natural companion for tools that generate images, such as
  Stable Diffusion, ComfyUI, or any automated export pipeline.

  AI IMAGE METADATA
  -----------------
  Folio reads the generation parameters that Stable Diffusion and compatible
  tools embed directly inside PNG files. Click the info button on any thumbnail
  to open a metadata panel showing:

    - Positive prompt
    - Negative prompt
    - Sampler, steps, CFG scale
    - Seed, model name, and any other recorded parameters

  You can select and copy any part of the text directly, or save the full
  parameter block to a .txt file with a single click.

  FILE MANAGEMENT
  ---------------
  Every common file operation is available directly from the thumbnail browser,
  without opening a separate file manager:

    Rename       Click the pencil icon on any thumbnail. Edit the name inline
                 and press Enter to confirm, or Escape to cancel.

    Delete       Click the trash icon on any thumbnail to move it to the
                 Recycle Bin after a confirmation prompt. Select multiple
                 thumbnails and use the Delete button in the bulk action bar
                 to remove them all at once.

    Convert      Right-click a single thumbnail and choose Save as PNG or
                 Save as JPEG to convert it with a save dialog. Or select
                 multiple images and use the bulk action bar to convert them
                 all in place with no dialog.

    Copy file    Right-click any thumbnail and choose Copy file to place it
                 on the Windows clipboard exactly like Ctrl+C in Explorer.
                 Navigate to any folder and paste with Ctrl+V.

  PERSISTENT SETTINGS
  -------------------
  Folio saves its state when you close it and restores everything when you
  reopen it: the folders you had loaded, which image you were viewing, the
  sidebar width, and the thumbnail size. You pick up exactly where you left off
  every single time.


--------------------------------------------------------------------------------
  GETTING STARTED
--------------------------------------------------------------------------------

  System requirements
  -------------------
  Windows 10 or Windows 11 (64-bit)

  Installation
  ------------
  There is no installer. Download Folio-portable.exe, place it anywhere you
  like — your Desktop, a folder, or a USB drive — and double-click to run.
  Folio writes its settings and thumbnail cache to your user data folder and
  leaves the rest of your system untouched.

  To uninstall, simply delete the .exe file.


--------------------------------------------------------------------------------
  TECH STACK
--------------------------------------------------------------------------------

  Shell         Electron
  UI            React + Vite  (via electron-vite)
  Packaging     electron-builder  (Windows portable)
  Clipboard     Windows Forms API via PowerShell (CF_HDROP)
  Metadata      Manual PNG tEXt chunk parser (no external libraries)
  Thumbnails    Electron nativeImage + SHA-1 disk cache


--------------------------------------------------------------------------------
  LICENSE
--------------------------------------------------------------------------------

  Released under the MIT License.
  Free to use, modify, and distribute — see the LICENSE file for full terms.


--------------------------------------------------------------------------------
  BUILT BY
--------------------------------------------------------------------------------

  Velvet Horizon Studio
  https://github.com/Velvet-Horizon-Studio

================================================================================
