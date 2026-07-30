import { Module } from '@nestjs/common';
import {
  TeacherController,
  StudentController,
  CourseController,
  LessonController,
  QuizController,
  QuizQuestionController,
  EnrollmentController,
  AssignmentController,
  AssignmentSubmissionController,
  CertificateController,
  TutorSessionController,
} from './education.controller';
import { EducationService } from './education.service';

/**
 * TrustOS Education domain module.
 *
 * One module per layer in the template chain. `product.module.ts` above this folder is the
 * aggregator AppModule imports by a fixed name — a template extending this one adds its own
 * folder beside it and lists both there, rather than editing anything in here.
 */
@Module({
  controllers: [
    TeacherController,
    StudentController,
    CourseController,
    LessonController,
    QuizController,
    QuizQuestionController,
    EnrollmentController,
    AssignmentController,
    AssignmentSubmissionController,
    CertificateController,
    TutorSessionController,
  ],
  providers: [EducationService],
  exports: [EducationService],
})
export class EducationDomainModule {}
