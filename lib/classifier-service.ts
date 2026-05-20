import { ConversationEntry } from './types';
import { ConversationStore } from './conversation-store';

export async function runClassificationBatch(store: ConversationStore) {
  const unclassified = store.getUnclassifiedConversations(10);
  if (unclassified.length === 0) return;

  // For real implementation, this would call the AI Batch API
  // We'll simulate the classification for now to show the UI capability
  for (const conv of unclassified) {
    const text = (conv.prompt + ' ' + conv.response).toLowerCase();
    
    let type: 'company' | 'outside' = 'outside';
    let category = 'personal';

    // Simple heuristic for demonstration
    if (text.includes('code') || text.includes('git') || text.includes('project') || text.includes('jira') || text.includes('office')) {
      type = 'company';
      category = 'professional';
    }
    
    store.updateClassification(conv.id, category, type, 0.95);
  }
}
