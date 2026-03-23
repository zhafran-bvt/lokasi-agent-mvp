export const PAGE_ANALYSIS_SCHEMA = {
  name: 'page_analysis',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      page_name: { type: 'string' },
      purpose: { type: 'string' },
      capability_summary: { type: 'string' },
      why_this_page: { type: 'string' },
      likely_features: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
            why_this_feature: { type: 'string' },
            confidence: { type: 'number' },
            risk_level: { type: 'string', enum: ['low', 'medium', 'high'] },
            important_actions: {
              type: 'array',
              items: { type: 'string' },
            },
          },
          required: ['name', 'description', 'why_this_feature', 'confidence', 'risk_level', 'important_actions'],
        },
      },
      candidate_next_actions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: { type: 'string' },
            why_this_action: { type: 'string' },
          },
          required: ['action', 'why_this_action'],
        },
      },
      version_hints: {
        type: 'array',
        items: { type: 'string' },
      },
    },
    required: ['page_name', 'purpose', 'capability_summary', 'why_this_page', 'likely_features', 'candidate_next_actions', 'version_hints'],
  },
};

export const DIFF_REVIEW_SCHEMA = {
  name: 'diff_review',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      summary: { type: 'string' },
      notable_changes: {
        type: 'array',
        items: { type: 'string' },
      },
      suspected_regressions: {
        type: 'array',
        items: { type: 'string' },
      },
      likely_intended_changes: {
        type: 'array',
        items: { type: 'string' },
      },
    },
    required: ['summary', 'notable_changes', 'suspected_regressions', 'likely_intended_changes'],
  },
};

export const GUIDED_ACTIONS_SCHEMA = {
  name: 'guided_actions',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      summary: { type: 'string' },
      progress_assessment: { type: 'string' },
      suspected_issue: { type: 'string' },
      retry_recommended: { type: 'boolean' },
      stop_reason: { type: 'string' },
      actions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            label: { type: 'string' },
            rationale: { type: 'string' },
            action_type: {
              type: 'string',
              enum: [
                'search_dataset',
                'toggle_source_mode',
                'paginate',
                'select_aggregation',
                'select_dataset',
                'choose_province',
                'apply_attribute_filter',
                'open_preview',
                'close_preview',
                'add_dataset',
                'dismiss_modal',
                'verify_state',
              ],
            },
            target_text: { type: 'string' },
            input_text: { type: 'string' },
            priority: { type: 'integer' },
            expected_signal: { type: 'string' },
          },
          required: ['label', 'rationale', 'action_type', 'target_text', 'input_text', 'priority', 'expected_signal'],
        },
      },
    },
    required: ['summary', 'progress_assessment', 'suspected_issue', 'retry_recommended', 'stop_reason', 'actions'],
  },
};

export const DATASET_FILTER_VERIFICATION_SCHEMA = {
  name: 'dataset_filter_verification',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      summary: { type: 'string' },
      verified: { type: 'boolean' },
      confidence: { type: 'number' },
      checked_column: { type: 'string' },
      checked_value: { type: 'string' },
      suspected_issue: { type: 'string' },
      notes: {
        type: 'array',
        items: { type: 'string' },
      },
    },
    required: ['summary', 'verified', 'confidence', 'checked_column', 'checked_value', 'suspected_issue', 'notes'],
  },
};

export const DATASET_TITLE_ALIAS_SCHEMA = {
  name: 'dataset_title_alias',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      summary: { type: 'string' },
      canonical_title: { type: 'string' },
      aliases: {
        type: 'array',
        items: { type: 'string' },
      },
      confidence: { type: 'number' },
      suspected_issue: { type: 'string' },
    },
    required: ['summary', 'canonical_title', 'aliases', 'confidence', 'suspected_issue'],
  },
};
