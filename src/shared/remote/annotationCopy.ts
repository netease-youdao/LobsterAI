export const remoteAnnotationTranslations = {
  zh: {
    remoteAnnotationBrowser: '文件注释', remoteAnnotationImage: '图片标注', remoteAnnotationUnnamed: '未命名文件',
    remoteAnnotationEmpty: '（空）', remoteAnnotationVisual: '标注画面请在电脑端查看。',
    remoteAnnotationTruncated: '注释较长，仅展示部分内容；请在电脑端查看完整注释。',
  },
  en: {
    remoteAnnotationBrowser: 'File annotations', remoteAnnotationImage: 'Image annotations', remoteAnnotationUnnamed: 'Untitled file',
    remoteAnnotationEmpty: '(empty)', remoteAnnotationVisual: 'View the annotated image on the desktop.',
    remoteAnnotationTruncated: 'Only part of the annotations is shown. View the full annotations on the desktop.',
  },
} as const;

export const remoteAnnotationPropertyLabels: Record<'zh' | 'en', Record<string, string>> = {
  zh: {
    text: '文字', color: '文字颜色', backgroundColor: '背景颜色', fontSize: '字号', fontFamily: '字体', fontWeight: '字重',
    borderRadius: '圆角', borderColor: '边框颜色', borderWidth: '边框宽度', paddingTop: '上内边距', paddingRight: '右内边距',
    paddingBottom: '下内边距', paddingLeft: '左内边距', marginTop: '上外边距', marginRight: '右外边距',
    marginBottom: '下外边距', marginLeft: '左外边距', width: '宽度', height: '高度', opacity: '不透明度',
    flexDirection: '排列方向', justifyContent: '主轴对齐', alignItems: '交叉轴对齐', gap: '间距', rowGap: '行间距', columnGap: '列间距',
  },
  en: {
    text: 'Text', color: 'Text color', backgroundColor: 'Background color', fontSize: 'Font size', fontFamily: 'Font family', fontWeight: 'Font weight',
    borderRadius: 'Corner radius', borderColor: 'Border color', borderWidth: 'Border width', paddingTop: 'Top padding', paddingRight: 'Right padding',
    paddingBottom: 'Bottom padding', paddingLeft: 'Left padding', marginTop: 'Top margin', marginRight: 'Right margin',
    marginBottom: 'Bottom margin', marginLeft: 'Left margin', width: 'Width', height: 'Height', opacity: 'Opacity',
    flexDirection: 'Layout direction', justifyContent: 'Main axis alignment', alignItems: 'Cross axis alignment', gap: 'Gap', rowGap: 'Row gap', columnGap: 'Column gap',
  },
};
