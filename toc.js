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
        this.innerHTML = '<ol class="chapter"><li class="chapter-item affix "><a href="index.html">OpenBook: AI Agent Harness Engineering</a></li><li class="chapter-item affix "><a href="preface.html">Preface</a></li><li class="chapter-item affix "><a href="reading-guide.html">Reading Guide</a></li><li class="chapter-item affix "><li class="spacer"></li><li class="chapter-item affix "><li class="part-title">Part I: Introduction</li><li class="chapter-item "><a href="part-1/intro.html"><strong aria-hidden="true">1.</strong> Part I Intro</a></li><li class="chapter-item "><a href="part-1/chapter-01.html"><strong aria-hidden="true">2.</strong> Chapter 1: From LLM to Agent</a></li><li class="chapter-item "><a href="part-1/chapter-02.html"><strong aria-hidden="true">3.</strong> Chapter 2: System Overview</a></li><li class="chapter-item affix "><li class="part-title">Part II: Agent Loop</li><li class="chapter-item "><a href="part-2/intro.html"><strong aria-hidden="true">4.</strong> Part II Intro</a></li><li class="chapter-item "><a href="part-2/chapter-03.html"><strong aria-hidden="true">5.</strong> Chapter 3: Agent Loop Anatomy</a></li><li class="chapter-item "><a href="part-2/chapter-04.html"><strong aria-hidden="true">6.</strong> Chapter 4: LLM API &amp; Streaming</a></li><li class="chapter-item "><a href="part-2/chapter-05.html"><strong aria-hidden="true">7.</strong> Chapter 5: Context Window Management</a></li><li class="chapter-item affix "><li class="part-title">Part III: Tool System</li><li class="chapter-item "><a href="part-3/intro.html"><strong aria-hidden="true">8.</strong> Part III Intro</a></li><li class="chapter-item "><a href="part-3/chapter-06.html"><strong aria-hidden="true">9.</strong> Chapter 6: Tool Design Philosophy</a></li><li class="chapter-item "><a href="part-3/chapter-07.html"><strong aria-hidden="true">10.</strong> Chapter 7: 40 Tools Tour</a></li><li class="chapter-item "><a href="part-3/chapter-08.html"><strong aria-hidden="true">11.</strong> Chapter 8: Tool Orchestration</a></li><li class="chapter-item affix "><li class="part-title">Part IV: Permission &amp; Security</li><li class="chapter-item "><a href="part-4/intro.html"><strong aria-hidden="true">12.</strong> Part IV Intro</a></li><li class="chapter-item "><a href="part-4/chapter-09.html"><strong aria-hidden="true">13.</strong> Chapter 9: Permission Model</a></li><li class="chapter-item "><a href="part-4/chapter-10.html"><strong aria-hidden="true">14.</strong> Chapter 10: Risk Classification</a></li><li class="chapter-item "><a href="part-4/chapter-11.html"><strong aria-hidden="true">15.</strong> Chapter 11: Hooks</a></li><li class="chapter-item affix "><li class="part-title">Part V: Multi-Agent</li><li class="chapter-item "><a href="part-5/intro.html"><strong aria-hidden="true">16.</strong> Part V Intro</a></li><li class="chapter-item "><a href="part-5/chapter-12.html"><strong aria-hidden="true">17.</strong> Chapter 12: Sub-Agent</a></li><li class="chapter-item "><a href="part-5/chapter-13.html"><strong aria-hidden="true">18.</strong> Chapter 13: Coordinator Pattern</a></li><li class="chapter-item "><a href="part-5/chapter-14.html"><strong aria-hidden="true">19.</strong> Chapter 14: Task System</a></li><li class="chapter-item "><a href="part-5/chapter-15.html"><strong aria-hidden="true">20.</strong> Chapter 15: Team &amp; Swarm</a></li><li class="chapter-item affix "><li class="part-title">Part VI: System Prompt &amp; Memory</li><li class="chapter-item "><a href="part-6/intro.html"><strong aria-hidden="true">21.</strong> Part VI Intro</a></li><li class="chapter-item "><a href="part-6/chapter-16.html"><strong aria-hidden="true">22.</strong> Chapter 16: System Prompt Pipeline</a></li><li class="chapter-item "><a href="part-6/chapter-17.html"><strong aria-hidden="true">23.</strong> Chapter 17: Memory Systems</a></li><li class="chapter-item affix "><li class="part-title">Part VII: MCP, Skills &amp; Extensions</li><li class="chapter-item "><a href="part-7/intro.html"><strong aria-hidden="true">24.</strong> Part VII Intro</a></li><li class="chapter-item "><a href="part-7/chapter-18.html"><strong aria-hidden="true">25.</strong> Chapter 18: MCP Protocol</a></li><li class="chapter-item "><a href="part-7/chapter-19.html"><strong aria-hidden="true">26.</strong> Chapter 19: Skills System</a></li><li class="chapter-item "><a href="part-7/chapter-20.html"><strong aria-hidden="true">27.</strong> Chapter 20: Commands &amp; Plugins</a></li><li class="chapter-item affix "><li class="part-title">Part VIII: Philosophy &amp; Frontier</li><li class="chapter-item "><a href="part-8/intro.html"><strong aria-hidden="true">28.</strong> Part VIII Intro</a></li><li class="chapter-item "><a href="part-8/chapter-21.html"><strong aria-hidden="true">29.</strong> Chapter 21: Dream System</a></li><li class="chapter-item "><a href="part-8/chapter-22.html"><strong aria-hidden="true">30.</strong> Chapter 22: Design Philosophy</a></li><li class="chapter-item affix "><li class="part-title">Part IX: Theory to Practice</li><li class="chapter-item "><a href="part-9/intro.html"><strong aria-hidden="true">31.</strong> Part IX Intro</a></li><li class="chapter-item "><a href="part-9/chapter-23.html"><strong aria-hidden="true">32.</strong> Chapter 23: Four Pillars</a></li><li class="chapter-item "><a href="part-9/chapter-24.html"><strong aria-hidden="true">33.</strong> Chapter 24: Sandbox &amp; Cloud Security</a></li><li class="chapter-item "><a href="part-9/chapter-25.html"><strong aria-hidden="true">34.</strong> Chapter 25: Self-Healing Loop</a></li><li class="chapter-item "><a href="part-9/chapter-26.html"><strong aria-hidden="true">35.</strong> Chapter 26: Deploy Your First Harness</a></li><li class="chapter-item affix "><li class="spacer"></li><li class="chapter-item affix "><li class="part-title">Appendix</li><li class="chapter-item "><a href="appendix/appendix-a.html"><strong aria-hidden="true">36.</strong> Appendix A: Architecture Diagrams</a></li><li class="chapter-item "><a href="appendix/appendix-b.html"><strong aria-hidden="true">37.</strong> Appendix B: Type Definitions</a></li><li class="chapter-item "><a href="appendix/appendix-c.html"><strong aria-hidden="true">38.</strong> Appendix C: Feature Flags</a></li><li class="chapter-item "><a href="appendix/appendix-d.html"><strong aria-hidden="true">39.</strong> Appendix D: Build Mini Agent Harness</a></li><li class="chapter-item affix "><li class="spacer"></li><li class="chapter-item affix "><a href="bibliography.html">Bibliography</a></li></ol>';
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
