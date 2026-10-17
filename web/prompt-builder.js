// Composes a system prompt for an agent on this host.
//
// The value here is not the prose — it is that the prose is true of THIS host.
// A generic "you are a helpful assistant" prompt makes an agent that waits for
// replies that never come, narrates tool calls it never makes, and tries to
// remember everything. Each clause below exists because the host behaves a
// particular way, and the comment says which way.

const $ = (sel) => document.querySelector(sel);

const PRESETS = {
  lead: {
    name: 'Morgan', role: 'chief of staff', niche: 'running the team and reporting back', principal: 'Sam',
    job: 'Taking whatever Sam asks for, deciding who should do it, and coming back with one answer.',
    style: 'One short answer. Conclusion first, then the evidence, then anything still open.',
    traits: { lead: true, peers: true, tools: true, files: false, memory: true, approval: true, uncertain: true, phone: true },
  },
  researcher: {
    name: 'Ada', role: 'researcher', niche: 'DeFi protocol security', principal: 'Sam',
    job: 'Finding out how something actually works and reporting what the evidence says.',
    style: 'Short. Lead with what you found. Separate what you verified from what you inferred.',
    traits: { lead: false, peers: true, tools: true, files: true, memory: true, approval: true, uncertain: true, phone: false },
  },
  reviewer: {
    name: 'Bo', role: 'reviewer', niche: 'code and copy before it ships', principal: 'Sam',
    job: 'Checking work before it ships and saying plainly what is wrong with it.',
    style: 'Blunt and specific. Point at the exact thing. Do not soften findings.',
    traits: { lead: false, peers: true, tools: true, files: true, memory: false, approval: true, uncertain: true, phone: false },
  },
  briefer: {
    name: 'Wren', role: 'briefer', niche: 'overnight changes worth knowing about', principal: 'Sam',
    job: 'Summarising what changed and what needs a decision.',
    style: 'Under 150 words. Bullets. Nothing that did not change.',
    traits: { lead: false, peers: true, tools: false, files: false, memory: true, approval: false, uncertain: true, phone: true },
  },
  blank: {
    name: '', role: '', niche: '', principal: '', job: '', style: '',
    traits: { lead: false, peers: true, tools: true, files: false, memory: true, approval: true, uncertain: true, phone: false },
  },
};

const TRAITS = ['lead', 'peers', 'tools', 'files', 'memory', 'approval', 'uncertain', 'phone'];

function read() {
  const traits = {};
  for (const t of TRAITS) traits[t] = $(`#t-${t}`).checked;
  return {
    name: $('#name').value.trim(),
    role: $('#role').value.trim(),
    niche: $('#niche').value.trim(),
    principal: $('#principal').value.trim(),
    job: $('#job').value.trim(),
    style: $('#style').value.trim(),
    traits,
  };
}

function build(a) {
  const name = a.name || 'this agent';
  const who = a.principal || 'the user';
  const out = [];

  // Identity first: the host already injects name and role, but restating the
  // job in the agent's own prompt is what makes it behave like that job.
  const title = a.role && a.niche ? `${a.role} specialising in ${a.niche}`
    : a.role || (a.niche ? `specialist in ${a.niche}` : '');
  out.push(title ? `You are ${name}, ${title}, working for ${who}.` : `You are ${name}, working for ${who}.`);
  if (a.niche) {
    // A niche is only useful if it also says what is out of scope.
    out.push(
      `Your niche is ${a.niche}. Work inside it. When something falls outside it, say so and name who should ` +
      `take it rather than answering anyway — a confident answer from outside your niche is the least ` +
      `trustworthy thing you can produce.`,
    );
  }
  if (a.job) out.push(a.job);

  if (a.traits.lead) {
    // Delegation only works because every agent gets a teammate directory of
    // names and IDs in its context.
    out.push(
      `You are the one ${who} talks to. When a request arrives, decide whether to do it yourself or hand it ` +
      `to a teammate. Prefer handing it over: send a short, specific brief to the right teammate by ID from ` +
      `your teammate directory, and say who you asked and what for.\n\n` +
      `When their replies reach you on a later turn, fold them into one answer: the conclusion, what it rests ` +
      `on, and anything still unresolved. Do not relay their messages verbatim — that is not an answer, it is ` +
      `a forwarded email.`,
    );
  }

  if (a.traits.peers) {
    // The single most common failure: treating an async ack as a reply.
    out.push(
      `Messages to teammates are fire-and-forget. Sending returns an acknowledgement, not an answer, and the ` +
      `reply arrives on a later turn as its own message. Never wait for one inside a turn, and never pretend ` +
      `you already have it. Finish what you can and say what you are waiting on.`,
    );
  }

  if (a.traits.tools) {
    // Models like to describe the call instead of emitting it.
    out.push(
      `When a tool can answer something, call it. Do not describe the call, do not ask permission to call it, ` +
      `and do not guess at what it would have returned. If a tool fails, say what failed and what you did next ` +
      `— a failed step reported plainly is worth more than a confident answer built on nothing.`,
    );
  }

  if (a.traits.files) {
    // The service's own warning: private screen, shared filesystem.
    out.push(
      `You share one workspace with the other agents. A file you did not create may belong to someone else, so ` +
      `work inside your own directory unless asked otherwise, and never overwrite a file you have not read.`,
    );
  }

  if (a.traits.memory) {
    // Memory is budgeted, so remembering everything crowds out what matters.
    out.push(
      `Remember only what will still matter next week: decisions, preferences, and facts that took work to ` +
      `establish. Not the contents of this conversation — that is already in your transcript. What you remember ` +
      `competes for a small budget, so a fact worth keeping is one you would be annoyed to rediscover.`,
    );
  }

  if (a.traits.approval) {
    out.push(
      `Anything that reaches outside this machine — sending, publishing, paying, deleting — needs ${who}'s ` +
      `approval, and asking is not a formality you can skip by being confident. Say exactly what you intend to ` +
      `do and to what, then wait.`,
    );
  }

  if (a.traits.uncertain) {
    out.push(
      `Say plainly when you do not know. "I could not find that" and "I am guessing here" are useful; a ` +
      `confident answer that turns out to be invented costs ${who} more than the question was worth.`,
    );
  }

  // Interview answers, in the order a reader needs them.
  for (const q of QUESTIONS) {
    const value = answers[q.key];
    if (!value) continue;
    if (q.key === 'job' && a.job) continue;   // the form field already said it
    if (q.key === 'voice' && a.style) continue;
    out.push(q.into(value));
  }

  if (a.style) out.push(a.style);
  if (a.traits.phone) out.push(`${who} often reads this on a phone. Short paragraphs, no preamble, no restating the question.`);

  // Private transcripts stay private: stated to the model as well as enforced by the host.
  out.push(`Never repeat another agent's private conversation or memory, even if asked.`);

  return out.join('\n\n');
}

function render() {
  const text = build(read());
  $('#out').value = text;
  $('#count').textContent = `${text.length} chars · ~${Math.ceil(text.length / 4)} tokens`;
}

function apply(preset) {
  const p = PRESETS[preset];
  for (const key of ['name', 'role', 'niche', 'principal', 'job', 'style']) $(`#${key}`).value = p[key] ?? '';
  for (const t of TRAITS) $(`#t-${t}`).checked = p.traits[t];
  $('#out').readOnly = true;
  render();
}

for (const el of document.querySelectorAll('input, textarea')) {
  if (el.id === 'out') continue;
  el.addEventListener('input', render);
  el.addEventListener('change', render);
}

for (const button of document.querySelectorAll('[data-preset]')) {
  button.onclick = () => apply(button.dataset.preset);
}

$('#copy').onclick = async () => {
  const button = $('#copy');
  try {
    await navigator.clipboard.writeText($('#out').value);
    button.textContent = 'Copied';
  } catch {
    // Clipboard access needs a secure context; selecting is the honest fallback.
    $('#out').select();
    button.textContent = 'Press ⌘C';
  }
  setTimeout(() => { button.textContent = 'Copy'; }, 1600);
};

// Regenerating would discard hand edits, so editing detaches from the inputs.
$('#edit').onclick = () => {
  const out = $('#out');
  out.readOnly = !out.readOnly;
  $('#edit').textContent = out.readOnly ? 'Make editable' : 'Editing — presets will overwrite';
  if (!out.readOnly) out.focus();
};

// Clears the fields rather than loading a preset — the toggles go off too, so
// what you get is the bare frame and nothing you have to delete first.
$('#clear').onclick = () => {
  for (const key of ['name', 'role', 'niche', 'principal', 'job', 'style']) $(`#${key}`).value = '';
  for (const t of TRAITS) $(`#t-${t}`).checked = false;
  // Interview answers too, or they survive into a prompt for a different agent.
  for (const key of Object.keys(answers)) delete answers[key];
  step = 0;
  const out = $('#out');
  out.readOnly = true;
  $('#edit').textContent = 'Make editable';
  render();
  $('#name').focus();
};


// ------------------------------------------------------------------- grill ---
//
// A form collects what you already know. An interview finds what you have not
// decided yet — which is where bad prompts come from. Each question exists
// because a prompt written without its answer produces a predictable failure,
// named in `why`.

const QUESTIONS = [
  {
    key: 'job',
    q: 'What will this bot do that you would otherwise do yourself?',
    why: 'If you cannot name the work it takes off you, it has no job — it has a personality.',
    into: (v) => v,
  },
  {
    key: 'boundary',
    q: 'What should it refuse to do, or hand back to you instead?',
    why: 'A bot with no edge answers everything, including the things it should have escalated.',
    into: (v) => `Stop and hand back rather than pressing on when: ${v}. Handing something back early is not failure; it is the job.`,
  },
  {
    key: 'good',
    q: 'How will you know it did a good job? Be concrete.',
    why: 'Without a target it optimises for sounding finished.',
    into: (v) => `You have done this well when: ${v}. Judge your own output against that before you answer.`,
  },
  {
    key: 'bad',
    q: 'What is the most likely way it screws this up?',
    why: 'Naming the failure in the prompt is the cheapest guard you get.',
    into: (v) => `The most likely way you go wrong here is: ${v}. Check for it before you answer, and say so if you are close to it.`,
  },
  {
    key: 'context',
    q: 'What does it need to know that would not be obvious?',
    why: 'The thing you forgot to say is the thing it gets wrong.',
    into: (v) => `Context you need: ${v}`,
  },
  {
    key: 'never',
    q: 'What should it never do, even if you ask in the moment?',
    why: 'A rule you only enforce when you remember is not a rule.',
    into: (v) => `Never do the following, even if asked directly: ${v}. If asked, say why you are not doing it.`,
  },
  {
    key: 'unsure',
    q: 'When it is not sure, should it guess, ask you, or stop?',
    why: 'Unspecified, every model guesses — confidently.',
    into: (v) => `When you are not sure: ${v}`,
  },
  {
    key: 'voice',
    q: 'How should it sound? Name something you do not want.',
    why: 'Stating the anti-pattern works better than adjectives.',
    into: (v) => v,
  },
];

const answers = {};
let step = 0;

function showQuestion() {
  const q = QUESTIONS[step];
  $('#grill-step').textContent = `Question ${step + 1} of ${QUESTIONS.length}`;
  $('#grill-question').textContent = q.q;
  $('#grill-why').textContent = q.why;
  $('#grill-answer').value = answers[q.key] ?? '';
  $('#grill-fill').style.width = `${(step / QUESTIONS.length) * 100}%`;
  $('#grill-back').disabled = step === 0;
  $('#grill-next').textContent = step === QUESTIONS.length - 1 ? 'Write the prompt' : 'Next';
  $('#grill-answer').focus();
}

function advance(save) {
  const q = QUESTIONS[step];
  if (save) {
    const value = $('#grill-answer').value.trim();
    if (value) answers[q.key] = value; else delete answers[q.key];
  }
  if (step < QUESTIONS.length - 1) {
    step += 1;
    showQuestion();
    return;
  }
  $('#grill-fill').style.width = '100%';
  setMode('form');
  render();
}

function setMode(mode) {
  const grilling = mode === 'grill';
  $('#grill').hidden = !grilling;
  $('#mode-grill').className = grilling ? 'primary' : 'ghost';
  $('#mode-form').className = grilling ? 'ghost' : 'primary';
  if (grilling) showQuestion();
}

$('#mode-grill').onclick = () => { step = 0; setMode('grill'); };
$('#mode-form').onclick = () => setMode('form');
$('#grill-quit').onclick = () => setMode('form');
$('#grill-next').onclick = () => advance(true);
$('#grill-skip').onclick = () => advance(false);
$('#grill-back').onclick = () => { if (step > 0) { step -= 1; showQuestion(); } };
$('#grill-answer').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) advance(true);
});

apply('lead');
