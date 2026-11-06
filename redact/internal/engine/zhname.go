package redact

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

// The model misses many Chinese names: 张伟 in "写封信给张伟，他住在…",
// 李娜, 陈建国 after 客户 all come back unlabelled, however low its
// threshold, and the names it finds often run on (「王芳，她下周一」,
// 「张伟先生」, 「林黛玉进贾府」). So, with the model on, a name is also
// found the way a reader finds one: a surname, one or two characters
// after it, and something around it that says a person is meant (客户,
// 我叫, 给…发, …先生, …说). A surname with nothing around it is left as
// it is: 王国的军队 and 张开的括号 are no one's.

// zhSurnames are the common single-character surnames.
const zhSurnames = "王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾肖萧田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付傅方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤常温康施文牛樊葛邢安齐易乔伍庞颜倪庄聂章鲁岳翟殷詹申欧耿关兰焦俞左柳甘祝包宁尚符舒阮柯纪梅童凌毕单季裴霍涂成苗谷盛曲翁冉骆蓝路游辛靳管柴蒙鲍华喻祁蒲房滕屈饶解牟艾尤阳时穆农司卓古吉缪简车项连芦麦褚娄窦戚岑景党宫费卜冷晏席卫米柏宗瞿桂全佟应臧闵苟邬边卞姬师仇栾隋商刁沙荣巫寇桑郎甄丛仲虞敖巩佘池查麻苑迟邝"

// zhCompound are the two-character surnames.
var zhCompound = []string{"欧阳", "司马", "上官", "诸葛", "东方", "皇甫", "尉迟", "公孙", "慕容", "令狐", "司徒", "夏侯", "长孙", "宇文", "轩辕", "端木", "独孤", "南宫", "西门", "钟离", "呼延", "申屠", "闻人", "澹台", "拓跋", "万俟"}

// zhNickSurnames are those 小 and 老 go before for a name (小王, 老李).
const zhNickSurnames = "王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾肖田董袁潘蒋蔡杜叶程苏魏吕丁沈姚卢姜崔钟谭陆汪范金廖贾夏方邹孟熊秦江薛段雷侯史陶贺顾毛郝龚邵钱严武戴孔汤"

// zhNotGiven can't be a given name's character: words a sentence goes on
// with after a name.
const zhNotGiven = "的了在是和与跟同说他她它我你您们这那个不也都就还把被给到对从向为以等及或并而吗呢吧啊去来有没要会能让请已将再又很更最先后上下里外时年日号发打回写问讲叫找用做看想知道得地着过之其此每各某该所反表认提负"

// zhWords begin with a surname but are words, not names.
var zhWords = []string{"张量", "张开", "张贴", "高度", "高效", "高级", "高速", "高亮", "高手", "高兴", "王国", "王者", "黄河", "黄色", "方法", "方向", "方式", "方案", "方便", "方面", "程序", "程度", "温度", "白色", "金额", "金融", "江湖", "石头", "马上", "周期", "周末", "周围", "周边", "文件", "文本", "文档", "文字", "文章", "余额", "安全", "安装", "安排", "钱包", "叶子", "毛病", "万一", "雷达", "宋体", "常量", "常用", "常见", "向量", "向上", "全部", "全局", "全面", "史上", "易用", "武器", "时间", "时候", "明天", "明确", "明白", "任何", "任务", "任意", "华为", "管理", "简单", "简介", "范围", "许多", "许可", "包括", "包含", "关于", "关系", "关闭", "连接", "成功", "成为", "应用", "应该", "单位", "单元", "单独", "司机", "车辆", "车子", "路径", "路由", "林业", "龙头", "柏林", "米饭", "宁可", "师傅", "老师", "老板", "老婆", "老公", "老家", "小时", "小心", "小说", "小姐", "小孩", "小组", "周一", "周二", "周三", "周四", "周五", "周六", "周日", "周天"}

// zhRoles before a name say it is one: 客户陈建国, 联系人：赵丽颖,
// 我叫黄晓明, 提交者是欧阳娜娜.
var zhRoles = []string{"客户", "联系人", "作者", "提交者", "审核人", "审批人", "负责人", "经办人", "收件人", "发件人", "收货人", "申请人", "报告人", "同事", "姓名", "名字", "署名", "签名", "我叫", "他叫", "她叫", "名叫", "叫做", "尊敬的", "亲爱的", "致", "@"}

// zhBefore are words that take a person after them (给张伟, 问李娜), so
// a name after them is one where something after it says so too.
var zhBefore = []string{"给", "找", "问", "让", "告诉", "通知", "联系", "抄送", "转给", "交给", "一下", "叫", "和", "与", "跟", "说", "请", "我是", "他是", "她是"}

// zhAfter are words that follow a person (张伟先生, 马云说, 张三反馈).
var zhAfter = []string{"先生", "女士", "小姐", "老师", "同学", "同志", "经理", "总监", "主任", "师傅", "医生", "律师", "教授", "博士", "说", "讲", "表示", "认为", "反馈", "提到", "提交", "负责", "告诉", "回复", "发", "打", "明天", "今天", "昨天", "已经", "他", "她"}

// zhTitles are what the model takes in after a name and isn't it.
var zhTitles = []string{"先生", "女士", "小姐", "老师", "同学", "同志", "经理", "总监", "主任", "师傅", "医生", "律师", "教授", "博士"}

// the lists above as sets, and mayStart the characters a name can start
// with
var (
	isSurname, isNick, notGiven = runes(zhSurnames), runes(zhNickSurnames), runes(zhNotGiven)
	mayStart                    = runes(zhSurnames + zhFirsts() + "小老")
)

func runes(s string) map[rune]bool {
	m := map[rune]bool{}
	for _, r := range s {
		m[r] = true
	}
	return m
}

func zhFirsts() string {
	var b strings.Builder
	for _, c := range zhCompound {
		r, _ := utf8.DecodeRuneInString(c)
		b.WriteRune(r)
	}
	return b.String()
}

// zhNameSpans are the Chinese names in s the model didn't find, as
// PERSON spans; person are those it did.
func zhNameSpans(s string, person []span) []span {
	if !hasHan(s) {
		return nil
	}
	var cs []span // candidates: kind "PERSON" where one is a name
	for i := 0; i < len(s); {
		a, b, ok := zhName(s, i)
		if b == 0 {
			_, n := utf8.DecodeRuneInString(s[i:])
			i += n
			continue
		}
		kind := ""
		if ok {
			kind = "PERSON"
		}
		cs = append(cs, span{a, b, kind, ByModel})
		i = b
	}
	// a name joined by 和, 与, 跟, 及 or 、 to one that is a name is one
	// too: 李娜和刘洋, where only 刘洋 has a word after it that says so
	starts, ends := map[int]bool{}, map[int]bool{}
	for _, p := range person {
		starts[p.start], ends[p.end] = true, true
	}
	for _, c := range cs {
		if c.kind != "" {
			starts[c.start], ends[c.end] = true, true
		}
	}
	for grew := true; grew; {
		grew = false
		for i, c := range cs {
			if c.kind == "" && joined(s, c, starts, ends) {
				cs[i].kind, grew = "PERSON", true
				starts[c.start], ends[c.end] = true, true
			}
		}
	}
	var out []span
	for _, c := range cs {
		if c.kind != "" {
			out = append(out, c)
		}
	}
	return out
}

// joined says only 和, 与, 跟, 及 or 、 is between c and a name, one
// that ends in ends or starts in starts.
func joined(s string, c span, starts, ends map[int]bool) bool {
	for _, j := range []string{"和", "与", "跟", "及", "、"} {
		if strings.HasPrefix(s[c.end:], j) && starts[c.end+len(j)] ||
			strings.HasSuffix(s[:c.start], j) && ends[c.start-len(j)] {
			return true
		}
	}
	return false
}

// zhName is the name that may start at i: its span, and whether what is
// around it says it is one (b is 0 where none can start there).
func zhName(s string, i int) (a, b int, ok bool) {
	rest := s[i:]
	if r, _ := utf8.DecodeRuneInString(rest); !mayStart[r] {
		return 0, 0, false
	}
	sur := 0
	for _, c := range zhCompound {
		if strings.HasPrefix(rest, c) {
			sur = len(c)
			break
		}
	}
	nick := false
	if sur == 0 {
		r, n := utf8.DecodeRuneInString(rest)
		switch {
		case (r == '小' || r == '老') && len(rest) > n:
			if r2, n2 := utf8.DecodeRuneInString(rest[n:]); isNick[r2] {
				sur, nick = n+n2, true
			}
		case isSurname[r]:
			sur = n
		}
	}
	if sur == 0 {
		return 0, 0, false
	}
	// the given name: none after 小王, else one or two characters
	ends := []int{}
	if nick {
		ends = append(ends, i+sur)
	} else {
		at := i + sur
		for k := 0; k < 2 && at < len(s); k++ {
			r, n := utf8.DecodeRuneInString(s[at:])
			if !unicode.Is(unicode.Han, r) || notGiven[r] {
				break
			}
			at += n
			ends = append(ends, at)
		}
	}
	if len(ends) == 0 {
		return 0, 0, false
	}
	for _, w := range zhWords {
		if strings.HasPrefix(rest, w) {
			return 0, 0, false
		}
	}
	// a Han character before it that is no cue makes it part of a word
	// (建国路), unless a cue ends there
	before := s[:i]
	role, verb := endsAny(before, zhRoles, true), endsAny(before, zhBefore, false)
	start := sentenceStart(before)
	if !role && !verb && !start {
		return 0, 0, false
	}
	// a surname and a title is a person (孙经理, 邓总)
	if !nick {
		for _, t := range append(zhTitles, "总") {
			if rest := s[i+sur:]; strings.HasPrefix(rest, t) && !(t == "总" && zhTotal(rest[len(t):])) {
				return i, i + sur + len(t), true
			}
		}
	}
	// the longest that ends where something after it says so
	for k := len(ends) - 1; k >= 0; k-- {
		e := ends[k]
		if after := s[e:]; startsAny(after, zhAfter) {
			return i, e, true
		} else if (role || verb) && endsWord(after) {
			return i, e, true
		}
	}
	if role {
		return i, ends[len(ends)-1], true
	}
	return i, ends[len(ends)-1], false
}

// zhTotal says 总 before s is a word's (总是, 总结, 总共), not a title.
func zhTotal(s string) bool {
	r, _ := utf8.DecodeRuneInString(s)
	return strings.ContainsRune("是结共体之数计线量部归算会得要", r)
}

// endsAny says s ends with one of ws; for a role, with one followed by
// 是, 为, a colon or spaces.
func endsAny(s string, ws []string, role bool) bool {
	if role {
		s = strings.TrimRight(s, " \t")
		for _, sep := range []string{"：", ":", "是", "为"} {
			if t, ok := strings.CutSuffix(s, sep); ok {
				s = strings.TrimRight(t, " \t")
				break
			}
		}
	}
	for _, w := range ws {
		if strings.HasSuffix(s, w) {
			return true
		}
	}
	return false
}

func startsAny(s string, ws []string) bool {
	for _, w := range ws {
		if strings.HasPrefix(s, w) {
			return true
		}
	}
	return false
}

// endsWord says a word ends where s starts: s is empty, or starts with no
// Han character.
func endsWord(s string) bool {
	r, _ := utf8.DecodeRuneInString(s)
	return s == "" || !unicode.Is(unicode.Han, r)
}

// sentenceStart says a name may start after s: s is empty or ends in
// punctuation or a space.
func sentenceStart(s string) bool {
	if s == "" {
		return true
	}
	r, _ := utf8.DecodeLastRuneInString(s)
	return unicode.IsPunct(r) || unicode.IsSpace(r) || unicode.IsSymbol(r)
}

// zhTrim is the model's name s[a:b] with what it ran on into cut off: at
// the first punctuation after a Han character, at a title
// (张伟先生). One that runs on past its name (林黛玉进贾府) is left so:
// a name of four characters is as often a whole one (田中太郎).
func zhTrim(s string, a, b int) (int, int) {
	v := s[a:b]
	if !hasHan(v) {
		return a, b
	}
	han := false
	for k, r := range v {
		if han && unicode.IsPunct(r) && r != '·' && r != '・' && utf8.RuneCountInString(v[:k]) >= 2 {
			v = v[:k]
			break
		}
		han = han || unicode.Is(unicode.Han, r)
	}
	for k := range v {
		if utf8.RuneCountInString(v[:k]) >= 2 && startsAny(v[k:], zhTitles) {
			v = v[:k]
			break
		}
	}
	return a, a + len(v)
}

func hasHan(s string) bool {
	for _, r := range s {
		if r >= 0x3400 && unicode.Is(unicode.Han, r) {
			return true
		}
	}
	return false
}
