// Populate the sidebar
//
// This is a script, and not included directly in the page, to control the total size of the book.
// The TOC contains an entry for each page, so if each page includes a copy of the TOC,
// the total size of the page becomes O(n**2).
class MDBookSidebarScrollbox extends HTMLElement {
    constructor() {
        super();
    }
    connectedCallback() {
        this.innerHTML = '<ol class="chapter"><li class="chapter-item affix "><a href="index.html">OpenBook: 构建 AI Agent 的 Harness 工程学</a></li><li class="chapter-item affix "><a href="preface.html">前言</a></li><li class="chapter-item affix "><a href="reading-guide.html">阅读指南</a></li><li class="chapter-item affix "><li class="spacer"></li><li class="chapter-item affix "><li class="part-title">Part I: 什么是 Agent Harness</li><li class="chapter-item "><a href="part-1/intro.html"><strong aria-hidden="true">1.</strong> Part I 导读</a></li><li class="chapter-item "><a href="part-1/chapter-01.html"><strong aria-hidden="true">2.</strong> Chapter 1: 从 LLM 到 Agent -- Harness 的角色</a></li><li class="chapter-item "><a href="part-1/chapter-02.html"><strong aria-hidden="true">3.</strong> Chapter 2: 系统全景 -- 一个 Agent 的解剖图</a></li><li class="chapter-item affix "><li class="part-title">Part II: Agent Loop -- 循环的艺术</li><li class="chapter-item "><a href="part-2/intro.html"><strong aria-hidden="true">4.</strong> Part II 导读</a></li><li class="chapter-item "><a href="part-2/chapter-03.html"><strong aria-hidden="true">5.</strong> Chapter 3: Agent Loop 解剖 -- 一轮对话的完整旅程</a></li><li class="chapter-item "><a href="part-2/chapter-04.html"><strong aria-hidden="true">6.</strong> Chapter 4: 与 LLM 对话 -- API 调用、流式响应与错误恢复</a></li><li class="chapter-item "><a href="part-2/chapter-05.html"><strong aria-hidden="true">7.</strong> Chapter 5: 上下文窗口管理 -- 有限记忆下的生存之道</a></li><li class="chapter-item affix "><li class="part-title">Part III: 工具系统 -- Agent 的手和脚</li><li class="chapter-item "><a href="part-3/intro.html"><strong aria-hidden="true">8.</strong> Part III 导读</a></li><li class="chapter-item "><a href="part-3/chapter-06.html"><strong aria-hidden="true">9.</strong> Chapter 6: 工具的设计哲学 -- 接口、注册与调度</a></li><li class="chapter-item "><a href="part-3/chapter-07.html"><strong aria-hidden="true">10.</strong> Chapter 7: 40 个工具巡礼 -- 从文件读写到浏览器</a></li><li class="chapter-item "><a href="part-3/chapter-08.html"><strong aria-hidden="true">11.</strong> Chapter 8: 工具编排 -- 并发、流式进度与结果预算</a></li><li class="chapter-item affix "><li class="part-title">Part IV: 安全与权限 -- Agent 的缰绳</li><li class="chapter-item "><a href="part-4/intro.html"><strong aria-hidden="true">12.</strong> Part IV 导读</a></li><li class="chapter-item "><a href="part-4/chapter-09.html"><strong aria-hidden="true">13.</strong> Chapter 9: 权限模型 -- 四层防线的设计</a></li><li class="chapter-item "><a href="part-4/chapter-10.html"><strong aria-hidden="true">14.</strong> Chapter 10: 风险分级与自动审批</a></li><li class="chapter-item "><a href="part-4/chapter-11.html"><strong aria-hidden="true">15.</strong> Chapter 11: Hooks -- 可编程的安全策略</a></li><li class="chapter-item affix "><li class="part-title">Part V: 多智能体 -- 从独行侠到团队</li><li class="chapter-item "><a href="part-5/intro.html"><strong aria-hidden="true">16.</strong> Part V 导读</a></li><li class="chapter-item "><a href="part-5/chapter-12.html"><strong aria-hidden="true">17.</strong> Chapter 12: 子 Agent 的诞生 -- fork、隔离与通信</a></li><li class="chapter-item "><a href="part-5/chapter-13.html"><strong aria-hidden="true">18.</strong> Chapter 13: 协调者模式 -- 四阶段编排法</a></li><li class="chapter-item "><a href="part-5/chapter-14.html"><strong aria-hidden="true">19.</strong> Chapter 14: 任务系统 -- 后台并行的基础设施</a></li><li class="chapter-item "><a href="part-5/chapter-15.html"><strong aria-hidden="true">20.</strong> Chapter 15: Team 与 Swarm -- 群体智能的实现</a></li><li class="chapter-item affix "><li class="part-title">Part VI: System Prompt 与记忆</li><li class="chapter-item "><a href="part-6/intro.html"><strong aria-hidden="true">21.</strong> Part VI 导读</a></li><li class="chapter-item "><a href="part-6/chapter-16.html"><strong aria-hidden="true">22.</strong> Chapter 16: System Prompt 的组装流水线</a></li><li class="chapter-item "><a href="part-6/chapter-17.html"><strong aria-hidden="true">23.</strong> Chapter 17: 记忆系统全景 -- 从文件发现到梦境整合</a></li><li class="chapter-item affix "><li class="part-title">Part VII: 扩展机制 -- 开放的 Agent</li><li class="chapter-item "><a href="part-7/intro.html"><strong aria-hidden="true">24.</strong> Part VII 导读</a></li><li class="chapter-item "><a href="part-7/chapter-18.html"><strong aria-hidden="true">25.</strong> Chapter 18: MCP -- 连接外部世界的协议</a></li><li class="chapter-item "><a href="part-7/chapter-19.html"><strong aria-hidden="true">26.</strong> Chapter 19: Skills -- 用户自定义能力</a></li><li class="chapter-item "><a href="part-7/chapter-20.html"><strong aria-hidden="true">27.</strong> Chapter 20: Commands 与 Plugin 体系</a></li><li class="chapter-item affix "><li class="part-title">Part VIII: 前沿与哲学</li><li class="chapter-item "><a href="part-8/intro.html"><strong aria-hidden="true">28.</strong> Part VIII 导读</a></li><li class="chapter-item "><a href="part-8/chapter-21.html"><strong aria-hidden="true">29.</strong> Chapter 21: Dream 系统 -- 会「睡觉」的 Agent</a></li><li class="chapter-item "><a href="part-8/chapter-22.html"><strong aria-hidden="true">30.</strong> Chapter 22: 设计哲学 -- 构建可信 AI Agent 的原则</a></li><li class="chapter-item affix "><li class="part-title">Part IX: 从理论到实践 -- OpenHarness</li><li class="chapter-item "><a href="part-9/intro.html"><strong aria-hidden="true">31.</strong> Part IX 导读</a></li><li class="chapter-item "><a href="part-9/chapter-23.html"><strong aria-hidden="true">32.</strong> Chapter 23: 四根支柱 -- 从 Harness 模式到部署架构</a></li><li class="chapter-item "><a href="part-9/chapter-24.html"><strong aria-hidden="true">33.</strong> Chapter 24: 沙箱与安全 -- 在云上约束 Agent</a></li><li class="chapter-item "><a href="part-9/chapter-25.html"><strong aria-hidden="true">34.</strong> Chapter 25: 自修复循环 -- 让 Agent 从失败中学习</a></li><li class="chapter-item "><a href="part-9/chapter-26.html"><strong aria-hidden="true">35.</strong> Chapter 26: 从零部署 -- 你的第一个 Agent Harness</a></li><li class="chapter-item affix "><li class="spacer"></li><li class="chapter-item affix "><li class="part-title">附录</li><li class="chapter-item "><a href="appendix/appendix-a.html"><strong aria-hidden="true">36.</strong> 附录 A: 架构总览图与数据流图</a></li><li class="chapter-item "><a href="appendix/appendix-b.html"><strong aria-hidden="true">37.</strong> 附录 B: 关键类型定义速查</a></li><li class="chapter-item "><a href="appendix/appendix-c.html"><strong aria-hidden="true">38.</strong> 附录 C: Feature Flag 完整清单</a></li><li class="chapter-item "><a href="appendix/appendix-d.html"><strong aria-hidden="true">39.</strong> 附录 D: 从零构建 Mini Agent Harness</a></li><li class="chapter-item affix "><li class="spacer"></li><li class="chapter-item affix "><a href="bibliography.html">参考文献</a></li></ol>';
        // Set the current, active page, and reveal it if it's hidden
        let current_page = document.location.href.toString();
        if (current_page.endsWith("/")) {
            current_page += "index.html";
        }
        var links = Array.prototype.slice.call(this.querySelectorAll("a"));
        var l = links.length;
        for (var i = 0; i < l; ++i) {
            var link = links[i];
            var href = link.getAttribute("href");
            if (href && !href.startsWith("#") && !/^(?:[a-z+]+:)?\/\//.test(href)) {
                link.href = path_to_root + href;
            }
            // The "index" page is supposed to alias the first chapter in the book.
            if (link.href === current_page || (i === 0 && path_to_root === "" && current_page.endsWith("/index.html"))) {
                link.classList.add("active");
                var parent = link.parentElement;
                if (parent && parent.classList.contains("chapter-item")) {
                    parent.classList.add("expanded");
                }
                while (parent) {
                    if (parent.tagName === "LI" && parent.previousElementSibling) {
                        if (parent.previousElementSibling.classList.contains("chapter-item")) {
                            parent.previousElementSibling.classList.add("expanded");
                        }
                    }
                    parent = parent.parentElement;
                }
            }
        }
        // Track and set sidebar scroll position
        this.addEventListener('click', function(e) {
            if (e.target.tagName === 'A') {
                sessionStorage.setItem('sidebar-scroll', this.scrollTop);
            }
        }, { passive: true });
        var sidebarScrollTop = sessionStorage.getItem('sidebar-scroll');
        sessionStorage.removeItem('sidebar-scroll');
        if (sidebarScrollTop) {
            // preserve sidebar scroll position when navigating via links within sidebar
            this.scrollTop = sidebarScrollTop;
        } else {
            // scroll sidebar to current active section when navigating via "next/previous chapter" buttons
            var activeSection = document.querySelector('#sidebar .active');
            if (activeSection) {
                activeSection.scrollIntoView({ block: 'center' });
            }
        }
        // Toggle buttons
        var sidebarAnchorToggles = document.querySelectorAll('#sidebar a.toggle');
        function toggleSection(ev) {
            ev.currentTarget.parentElement.classList.toggle('expanded');
        }
        Array.from(sidebarAnchorToggles).forEach(function (el) {
            el.addEventListener('click', toggleSection);
        });
    }
}
window.customElements.define("mdbook-sidebar-scrollbox", MDBookSidebarScrollbox);
