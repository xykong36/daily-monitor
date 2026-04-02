from dataclasses import dataclass, field


@dataclass
class Article:
    title: str
    link: str
    author: str
    pub_date: str
    description: str
    content_html: str
    content_text: str = ""
    paragraphs: list[str] = field(default_factory=list)


@dataclass
class AnalysisResult:
    outline_summary: str = ""
    detailed_outline: list[dict] = field(default_factory=list)  # [{"heading", "summary", "key_points"}]
    key_arguments: list[dict] = field(default_factory=list)     # [{"argument", "evidence", "significance"}]
    keywords: list[dict] = field(default_factory=list)
    logic_chain: str = ""
    bilingual_sections: list[dict] = field(default_factory=list)
    devil_advocate: list[dict] = field(default_factory=list)
    overall_assessment: str = ""
