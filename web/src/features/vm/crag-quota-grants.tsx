import { dateTime, numberLabel } from './crag-runtime-counts'
import type { CragHostStatus } from './queries'

/**
 * 每张兑换券买到的那一段额度。
 *
 * 概况区刻意只给两个数字（见 `crag-runtime-counts.tsx` 的说明：少展示一个数字
 * 就少一处能产生别名的地方），所以这张表是独立的次要明细，不往概况里加计数，
 * 列名也沿用既有叫法 ——「槽位」「到期」—— 不另起名字。
 *
 * **只在有多段额度时出现。** 一段的时候概况已经把它说完了，再列一遍只是噪音。
 *
 * 它存在的理由是消除一个具体误解：概况里的「到期」取的是**最早到期的那一段**，
 * 因为那一段失效后可用槽位就会变少、授权必须重签。它不是「订阅到此为止」——
 * 其余额度照旧有效。只看概况的用户会以为那天一到全部停摆。
 */
export function CragQuotaGrants({ status }: { status?: CragHostStatus }) {
  const grants = status?.quota_grants
  if (!grants || grants.length < 2) return null
  const soonest = grants[0]?.expires_at

  return (
    <div className='min-w-0 space-y-1.5'>
      <p className='text-xs text-muted-foreground'>
        共 {grants.length}{' '}
        段额度，各自独立计时。概况里的「到期」是下面最早的那一 段 ——
        它失效后可用槽位减少，其余额度不受影响。
      </p>
      <div className='min-w-0 overflow-x-auto'>
        <table className='w-full text-xs'>
          <thead>
            <tr className='text-muted-foreground'>
              <th className='pb-1.5 text-left font-medium'>来源</th>
              <th className='pb-1.5 text-right font-medium'>槽位</th>
              <th className='pb-1.5 text-right font-medium'>到期</th>
            </tr>
          </thead>
          <tbody className='tabular-nums'>
            {grants.map((grant, index) => {
              const date = new Date(grant.expires_at * 1000)
              const first = grant.expires_at === soonest
              return (
                <tr
                  key={`${grant.code_id ?? 'baseline'}-${grant.expires_at}-${index}`}
                  className='border-t border-border/50'
                >
                  <td className='py-1'>
                    {grant.code_id ? (
                      <span className='font-mono wrap-anywhere'>
                        {grant.code_id.slice(0, 8)}
                      </span>
                    ) : (
                      // 无券号的那一段：H1 宿主机的首次兑换记为基线额度，
                      // 授权侧就没有券标识可给（host_redeem 的 legacy 分支）。
                      <span className='text-muted-foreground'>初始额度</span>
                    )}
                  </td>
                  <td className='py-1 text-right'>
                    {numberLabel(grant.slot_limit ?? 'unlimited')}
                  </td>
                  <td className='py-1 text-right'>
                    <time dateTime={date.toISOString()}>
                      {dateTime.format(date)}
                    </time>
                    {first ? (
                      <span className='text-muted-foreground'>{' · 最早'}</span>
                    ) : null}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
