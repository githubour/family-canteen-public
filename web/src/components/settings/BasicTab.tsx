import {
  MAX_HEADCOUNT,
  MEAL_LABEL,
  MEAL_TYPES,
  type AppSettings,
  type MealType,
} from '../../api/types';
import { ChoiceChip, Stepper } from '../ui/base';
import { WEEKDAY_SHORT, parseWeekdays, stringifyWeekdays } from '../../lib/format';
import { Field } from './Field';
import type { SettingsDraftProps } from './types';

/** 「默认在外吃」的星期设置键，显式收窄成字面量联合，便于安全地写进草稿 */
function awayKey(meal: MealType): 'away.breakfast' | 'away.lunch' | 'away.dinner' {
  return `away.${meal}`;
}

/** 基本：三餐截单时间、默认人数、默认在外吃的星期（改动都先进草稿，由 SettingsSheet 统一保存） */
export function BasicTab({ value, setDraft }: SettingsDraftProps) {
  return (
    <div className="space-y-3">
      <Field label="早餐截单时间" hint="早上这点之前点，大厨来得及做">
        <input
          type="time"
          value={value('cutoff.breakfast')}
          onChange={(event) => setDraft((previous) => ({ ...previous, 'cutoff.breakfast': event.target.value }))}
          className="h-10 w-32 rounded-xl2 border border-cream-400 bg-white px-3 text-[15px] tabular-nums"
        />
      </Field>
      <Field label="午餐截单时间" hint="过了这个时间点菜会二次确认">
        <input
          type="time"
          value={value('cutoff.lunch')}
          onChange={(event) => setDraft((previous) => ({ ...previous, 'cutoff.lunch': event.target.value }))}
          className="h-10 w-32 rounded-xl2 border border-cream-400 bg-white px-3 text-[15px] tabular-nums"
        />
      </Field>
      <Field label="晚餐截单时间" hint="建议比开饭提前 1.5 小时">
        <input
          type="time"
          value={value('cutoff.dinner')}
          onChange={(event) => setDraft((previous) => ({ ...previous, 'cutoff.dinner': event.target.value }))}
          className="h-10 w-32 rounded-xl2 border border-cream-400 bg-white px-3 text-[15px] tabular-nums"
        />
      </Field>
      <Field label="默认用餐人数" hint="用于配菜推荐与人均营养换算">
        <Stepper
          value={Number(value('default.headcount')) || 3}
          min={1}
          max={MAX_HEADCOUNT}
          onChange={(next) => setDraft((previous) => ({ ...previous, 'default.headcount': String(next) }))}
        />
      </Field>

      <div className="rounded-xl2 border border-cream-300 bg-white p-3.5">
        <p className="text-[14px] font-semibold">默认在外吃的日子</p>
        <p className="mb-3 mt-0.5 text-[11px] leading-4 text-ink-400">
          勾上的星期默认不在家吃，不计入人均统计（比如工作日午餐在公司吃）。
          哪周某天临时在家吃，到点菜页正常点菜就行——有订单即算在家吃。
          <br />
          改动只影响今天与以后：已经过去的日子会保持它们当时的判定，历史统计与营养折算不会跟着变。
        </p>
        <div className="space-y-1.5">
          {MEAL_TYPES.map((meal) => {
            const days = parseWeekdays(value(awayKey(meal)));
            return (
              <div key={meal} className="flex items-center gap-2">
                <span className="w-7 shrink-0 text-[12px] text-ink-600">{MEAL_LABEL[meal]}</span>
                <div className="flex flex-1 gap-1">
                  {WEEKDAY_SHORT.map((label, index) => {
                    const on = days.includes(index);
                    return (
                      <ChoiceChip
                        key={label}
                        active={on}
                        className="h-8 flex-1 text-[11px]"
                        onClick={() => {
                          const next = on ? days.filter((day) => day !== index) : [...days, index];
                          const patch: Partial<AppSettings> = {};
                          patch[awayKey(meal)] = stringifyWeekdays(next);
                          setDraft((previous) => ({ ...previous, ...patch }));
                        }}
                      >
                        {label}
                      </ChoiceChip>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
        <p className="mt-2.5 text-[11px] leading-4 text-ink-400">
          改了记得点下面的「保存设置」。
        </p>
      </div>
    </div>
  );
}
