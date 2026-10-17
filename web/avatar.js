// The face of an agent. Six shapes, nine colours.
//
// This module is the single source of truth for both sides: the browser imports
// avatarSvg() to draw a face, and src/server.js imports the normalisers to
// validate what a client asks for. It touches the DOM only inside avatarSvg(),
// so Node can import it without a document.

// Six bodies, eight characters, nine colours. Every combination is drawn as one
// static face, so nothing in the picker is offered without its file. Thinking
// and typing are shown by a CSS class on that same face (see style.css).
export const SHAPE_NAMES = ['round', 'blob', 'square', 'oval', 'triangle', 'droplet'];
export const DEFAULT_SHAPE = 'round';
export const STYLES = ['crown', 'glasses', 'monocle', 'hair', 'pencil', 'headset', 'plain', 'cap'];
export const DEFAULT_STYLE = 'plain';

export const COLORS = ['#51FFCD', '#37FF5D', '#F5FF32', '#FF8234', '#FEDE8D', '#E1FFF3', '#B5B5B5', '#000000', '#FE3E51'];
export const DEFAULT_COLOR = COLORS[0];

// Hair is its own choice where the renders allow it: a colour where the hair can
// be told apart from the other accessories. There is no bald face; an agent saved
// with hair 'none' normalises to the default and keeps its haired face.
export const HAIRS = ['dark', 'white'];
export const DEFAULT_HAIR = 'dark';
export const HAIR_STYLES = ['hair', 'pencil', 'monocle', 'glasses', 'headset'];
export function hasHair(style) { return HAIR_STYLES.includes(normalizeStyle(style)); }
export function normalizeHair(hair) { return HAIRS.includes(hair) ? hair : DEFAULT_HAIR; }
/** The hair choices that mean something for one character; one entry means the row can hide. */
export function hairOptions(style) {
  return hasHair(style) ? ['dark', 'white'] : ['dark'];
}

const HEX = /^#[0-9a-fA-F]{6}$/;

// Older face names map onto current bodies, so an agent keeps a face rather
// than falling back to the default.
const LEGACY_SHAPES = { egg: 'oval', dome: 'round', pebble: 'round', chip: 'square' };

/** Unknown shapes fall back rather than throw: a bad avatar must never cost an agent. */
export function normalizeShape(shape) {
  if (SHAPE_NAMES.includes(shape)) return shape;
  return LEGACY_SHAPES[shape] ?? DEFAULT_SHAPE;
}

export function normalizeStyle(style) {
  return STYLES.includes(style) ? style : DEFAULT_STYLE;
}

/**
 * Faces exist only in the six palette colours, so any other hex snaps to the
 * nearest one: an API caller's green stays green rather than becoming a broken
 * image or the default teal. Anything that is not a colour at all is the default.
 */
export function normalizeColor(color) {
  if (!HEX.test(color ?? '')) return DEFAULT_COLOR;
  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const want = rgb(color);
  const distance = (hex) => rgb(hex).reduce((sum, c, i) => sum + (c - want[i]) ** 2, 0);
  return COLORS.reduce((best, c) => (distance(c) < distance(best) ? c : best), COLORS[0]);
}

// Run phases the face shows, each as an `is-<phase>` class on the static image.
export const PHASES = ['thinking', 'typing'];

// Bumped when the faces are rebuilt. Browsers that cached the old files under
// a week-long immutable header will not ask again; a new URL makes them.
export const AVATAR_BUILD = '8';

function assetName(shape, style, color, hair = DEFAULT_HAIR) {
  const base = `avatar-${normalizeShape(shape)}-${normalizeStyle(style)}-${normalizeColor(color).replace('#', '').toUpperCase()}`;
  const h = normalizeHair(hair);
  if (h === 'white' && hasHair(style)) return `${base}-white`;
  return base;
}

/** The idle face. */
export function staticFace(shape, style, color, hair) {
  return `/avatars/${assetName(shape, style, color, hair)}.png?v=${AVATAR_BUILD}`;
}

/** An <img> for a face. Browser only; the server never calls this. */
export function avatarImage(shape, style, color, { size = 28, className = 'avatar', phase = null, hair = DEFAULT_HAIR, image = null } = {}) {
  const img = image ?? document.createElement('img');
  // The face is always the static file; a working phase only adds a class, so
  // thinking and typing animate in CSS without fetching anything new.
  img.className = PHASES.includes(phase) ? `${className} is-${phase}` : className;
  const src = staticFace(shape, style, color, hair);
  if (img.getAttribute('src') !== src) img.src = src;
  img.width = size;
  img.height = size;
  img.alt = '';
  img.draggable = false;
  return img;
}

