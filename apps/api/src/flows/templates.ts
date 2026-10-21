import type { FlowTemplateId } from '@littleboss/shared';

export interface StepDef {
  key: string;
  kind: 'input' | 'ai' | 'schedule' | 'manual' | 'handoff';
  title: string;
  help: string;
  link?: { label: string; url: string };
}

export interface TemplateDef {
  id: FlowTemplateId;
  defaultTitle: string;
  /** Days of the week the routine publishes on (0 = Sunday). */
  publishDays: number[];
  steps: StepDef[];
}

/**
 * Templates are plain data: a list of steps. Nothing here runs; the service reads it.
 * Editing a template changes what every flow made from it shows.
 */
export const TEMPLATES: Record<FlowTemplateId, TemplateDef> = {
  'podcast-episode': {
    id: 'podcast-episode',
    defaultTitle: '新的一集',
    publishDays: [1, 4],
    steps: [
      {
        key: 'notes',
        kind: 'input',
        title: '寫下這集重點',
        help: '幾句話或條列都行，AI 只會依這裡寫的內容擬標題和描述。',
      },
      {
        key: 'draft',
        kind: 'ai',
        title: 'AI 擬標題與描述',
        help: '請 AI 擬三組，你選一組、可以直接改。',
      },
      {
        key: 'schedule',
        kind: 'schedule',
        title: '選發佈時間',
        help: '預設是接下來的週一與週四。',
      },
      {
        key: 'auphonic',
        kind: 'manual',
        title: '用 Auphonic 調音',
        help: '把錄好的 m4a 丟上去，處理完下載 mp3。',
        link: { label: '打開 Auphonic', url: 'https://auphonic.com' },
      },
      {
        key: 'trim',
        kind: 'manual',
        title: '去掉頭尾廣告',
        help: '在 GarageBand 剪掉頭尾，匯出最後的 mp3。',
      },
      {
        key: 'upload',
        kind: 'handoff',
        title: '上傳到 Firstory',
        help: '上傳音檔，貼上標題與描述，選好發佈時間。',
        link: { label: '打開 Firstory', url: 'https://firstory.me' },
      },
    ],
  },
};
