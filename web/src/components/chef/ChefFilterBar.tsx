import { Segmented } from '../ui/base';
import { DaySwitcher } from '../ui/DaySwitcher';
import { FILTER_OPTIONS, type Filter } from './types';

/**
 * 大厨看板的吸顶筛选条：日期前后翻 + 回今天、状态筛选。
 * 掌勺人药丸在页头（与点菜页同款），订单列表本身按全天餐别分组，这里不放餐次切换。
 * 平板下：日期一行、筛选一行。744px 起的两列布局避免筛选被压成竖排字。
 */
export function ChefFilterBar({
  date,
  onChangeDate,
  filter,
  onSelectFilter,
}: {
  date: string;
  onChangeDate: (date: string) => void;
  filter: Filter;
  onSelectFilter: (filter: Filter) => void;
}) {
  return (
    <>
      {/* 吸顶位置 = 页头高度(62px) + 灵动岛让位：页头在全面屏下会变高这么多 */}
      <div className="glass-panel sticky top-[calc(env(safe-area-inset-top,0px)+62px)] z-20 space-y-2.5 px-4 py-2.5 lg:grid lg:grid-cols-[auto_1fr] lg:items-center lg:gap-x-3 lg:gap-y-2.5 lg:space-y-0">
        <DaySwitcher date={date} onChange={onChangeDate} />

        <Segmented
          className="lg:col-span-2 lg:max-w-[720px]"
          value={filter}
          onChange={onSelectFilter}
          options={FILTER_OPTIONS}
        />
      </div>
    </>
  );
}
