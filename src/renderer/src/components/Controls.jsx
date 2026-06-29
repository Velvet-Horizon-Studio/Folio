import './Controls.css'

export default function Controls({
  isPlaying, onTogglePlay,
  onPrev, onNext,
  hasImages,
  intervalMs, onIntervalChange,
  isFullscreen, controlsVisible, onHelp,
  keepAwake, onKeepAwakeToggle,
  shuffled, onShuffleToggle,
  transition, onTransitionChange,
  transitionDuration, onTransitionDurationChange,
  currentIndex, total,
}) {
  function formatMs(ms) {
    return `${ms / 1000}s`
  }

  return (
    <div className={`controls${isFullscreen ? ' controls-fullscreen' : ''}${isFullscreen && !controlsVisible ? ' controls-hidden' : ''}`}>
      {/* Playback */}
      <div className="ctrl-group ctrl-playback">
        <button className="ctrl-btn ctrl-btn-nav" onClick={onPrev} disabled={!hasImages} title="Previous">
          ◀
        </button>

        <button
          className={`ctrl-btn ctrl-btn-play${isPlaying ? ' playing' : ''}`}
          onClick={onTogglePlay}
          disabled={!hasImages}
          title={isPlaying ? 'Pause' : 'Play'}
        >
          {isPlaying ? '⏸' : '▶'}
        </button>

        <button className="ctrl-btn ctrl-btn-nav" onClick={onNext} disabled={!hasImages} title="Next">
          ▶▶
        </button>
      </div>

      {/* Speed */}
      <div className="ctrl-group ctrl-speed">
        <span className="ctrl-label">Speed</span>
        <input
          type="range"
          min={500}
          max={30000}
          step={250}
          value={intervalMs}
          onChange={(e) => onIntervalChange(Number(e.target.value))}
          className="ctrl-slider"
          title={`Interval: ${formatMs(intervalMs)}`}
        />
        <span className="ctrl-speed-value">{formatMs(intervalMs)}</span>
      </div>

      {/* Options */}
      <div className="ctrl-group ctrl-options">
        <button
          className={`ctrl-btn ctrl-btn-option${shuffled ? ' active' : ''}`}
          onClick={onShuffleToggle}
          title="Shuffle"
        >
          ⇄ Shuffle
        </button>

        <div className="ctrl-select-wrap">
          <select
            className="ctrl-select"
            value={transition}
            onChange={(e) => onTransitionChange(e.target.value)}
            title="Transition"
          >
            <option value="fade">Fade</option>
            <option value="slide-up">Slide Up</option>
            <option value="slide-down">Slide Down</option>
            <option value="slide-left">Slide Left</option>
            <option value="slide-right">Slide Right</option>
            <option value="zoom-in">Zoom In</option>
            <option value="zoom-out">Zoom Out</option>
            <option value="blur">Blur</option>
            <option value="rotate">Rotate</option>
            <option value="flip">Flip</option>
            <option value="none">None</option>
          </select>
        </div>

        {transition !== 'none' && (
          <>
            <span className="ctrl-label">Duration</span>
            <input
              type="range"
              min={100}
              max={10000}
              step={100}
              value={transitionDuration}
              onChange={(e) => onTransitionDurationChange(Number(e.target.value))}
              className="ctrl-slider ctrl-slider-short"
              title={`Transition duration: ${formatMs(transitionDuration)}`}
            />
            <span className="ctrl-speed-value">{formatMs(transitionDuration)}</span>
          </>
        )}

        <button
          className={`ctrl-btn ctrl-btn-option${keepAwake ? ' active' : ''}`}
          onClick={onKeepAwakeToggle}
          title="Keep the screen awake while the slideshow is playing"
        >
          ☕ Keep Awake
        </button>

        <button
          className="ctrl-btn ctrl-btn-help"
          onClick={onHelp}
          title="Help — open the Folio guide"
          aria-label="Help"
        >
          ?
        </button>

      </div>
    </div>
  )
}
