import type { Dispatch, SetStateAction } from 'react';
import type { AppSettings } from '../../api/types';

/**
 * 基本 / 通知页签的草稿接口：草稿由 SettingsSheet 持有、统一提交（保存按钮在页签之外），
 * 页签只负责渲染与改草稿，保证切页签不丢未保存的改动。
 */
export interface SettingsDraftProps {
  /** 取当前生效值：优先本地草稿，其次已保存的设置 */
  value: <K extends keyof AppSettings>(key: K) => string;
  setDraft: Dispatch<SetStateAction<Partial<AppSettings>>>;
}
