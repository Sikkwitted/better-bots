import { PRIORITY_REASONS } from '../services/message-service.js';

// SendToAgent is the model tool for peer messages: the schema requires
// a target ID and a message, permits images, and has an optional one-to-one priority
// flag. The return value is a delivery acknowledgement, never a reply.

export function sendToAgentTool({ host }) {
  const recipients = () => [
    ...host.registry.list().map((a) => ({ id: a.id, name: a.profile.name, desk: a.profile.desk ?? '', role: a.profile.role ?? '' })),
    ...host.rooms.list().map((r) => ({ id: r.id, name: r.name ?? r.purpose, kind: 'room' })),
  ];
  return {
    name: 'SendToAgent',
    description:
      'Send one message to another agent or a room. Fire-and-forget: you get an acknowledgement now; ' +
      'any answer arrives as a later message. Do not wait for it. Select the exact target_id from the current schema and teammate directory, not old messages. ' +
      'A rejected input delivered nothing: correct it from the returned directory and retry once. Send-once rules count successful sends, not rejected inputs. Never retry an acknowledged or ambiguous send blindly.',
    side_effect: 'Queues a durable message and schedules a later hidden wake for the recipient.',
    permission: { action: (input, { run }) => host.coordination.requiresApproval(run, input.target_id) ? 'coordination.fanout' : 'coordination.handoff', target: (input) => JSON.stringify({ target_id: input.target_id, recipients: host.coordination.targets(input.target_id) }) },
    get input_schema() { return {
      type: 'object',
      required: ['target_id', 'message'],
      properties: {
        target_id: { type: 'string', enum: recipients().map((r) => r.id), description: 'Choose the exact current agent or room ID. Match name, role and desk in the directory; never guess or copy an ID from history.' },
        message: {
          type: 'string',
          description: 'A small handoff: goal, state, evidence, constraint, next action. Summarise; do not forward private wording.',
        },
        images: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 4,
          description: 'Optional uploaded image IDs (img_...) from this conversation, for an agent or room.',
        },
        priority: {
          type: 'boolean',
          description:
            'One-to-one only. Supersedes the recipient\'s non-user work. Never interrupts the user lane.',
        },
        priority_reason: {
          type: 'string',
          enum: PRIORITY_REASONS,
          description: 'Required when priority is true.',
        },
      },
    }; },
    invalid_input_result({ errors }) {
      return {
        ok: false, error: 'invalid_input', details: errors,
        delivered: false, retryable: true,
        recipients: recipients(),
        message: 'Nothing was sent or queued. Correct the invalid fields; select the intended recipient by name, role and desk from this current directory and retry once. This is not a duplicate handoff. Do not choose a different recipient just because its ID is similar. If identity is ambiguous, stop and report it.',
      };
    },
    handler({ agent, input, run, authorization }) {
      if (authorization?.target !== JSON.stringify({ target_id: input.target_id, recipients: host.coordination.targets(input.target_id) })) throw new Error('recipient set changed during approval');
      const coordination_id = host.coordination.commit(run, input.target_id, authorization?.action === 'coordination.fanout');
      // The host, not the tool, decides on wakes and interruption.
      return host.deliverPeerMessage({
        coordination_id,
        automation_id: run?.payload?.automation_id ?? null,
        parent_run_id: run?.id ?? null,
        sender_id: agent.id,
        target_id: input.target_id,
        text: input.message,
        attachments: input.images ?? [],
        priority: Boolean(input.priority),
        priority_reason: input.priority_reason ?? null,
        // A message sent while handling an inbound message inherits its depth,
        // which is what stops peer ping-pong.
        chain_depth: (run?.payload?.chain_depth ?? 0) + 1,
      });
    },
  };
}
